# 2026-08-01 shell-env 解析(双击启动拿不到 harness PATH)

## 起因

用户反馈:从终端启动 monkey-deck 能正常发现/加载 harness(omp/opencode),
**Finder/Dock 双击启动则不行**——harness 列表为空、发消息 spawn 失败。

## 根因(已在本机实证)

macOS 双击启动走 launchd/LaunchServices,进程只继承系统默认 PATH
(`/etc/paths` + `/etc/paths.d`),**不读** `.zshrc`/`.zprofile`。本机实测:

- shell PATH 含 `~/.bun/bin`(omp 装这里)、`~/.opencode/bin`(opencode 装这里)
- `launchctl getenv PATH` 为空 → 双击启动时这些用户级目录全不在 PATH 里

项目两处靠进程 PATH 解析 harness:
- 发现:`internal/harness/discover.go:43` `exec.LookPath("omp")` → 失败 → `Installed=false`
- spawn:`internal/acp/runner.go:196` `exec.CommandContext` 启动时再 LookPath → 也失败

终端启动时继承完整 shell PATH,所以一切正常。这是 macOS 上所有 GUI app
的经典问题(VS Code / superset / purplemux / sindresorhus fix-path 都处理过)。

## 设计(多轮对话敲定,只做 v1)

**主方案:shell-env 解析**(VS Code `shellEnv.ts` 模式)——启动时 spawn 用户的
登录+交互 shell,读它 `env` 输出里的 PATH,**merge 进进程环境**。我们借 shell 的
脑子读配置,**自己不读/不解析** `.zshrc`/`.zprofile`(只有 shell 自己能正确解释
source 链/条件/函数)。

**只动 PATH,且是 union 合并**(非覆盖):shell PATH 的目录按其声明顺序在前,
进程当前 PATH 里 shell 没有的目录追加在后(`mergePATH`),**绝不丢目录**。这样:
- Finder 双击启动(当前 PATH 是 launchd 最小集,是 shell PATH 子集)→ union 结果
  == shell PATH,与覆盖无异;
- 终端启动若 session 临时加了 `/tmp/extra`(如临时装的 harness),覆盖会丢掉它
  让 harness 消失,union 则保留(降级到 shell 之后)。

**幂等**:进程内 `sync.Once` 守护,首个调用方 spawn shell、缓存结果(含 error),
后续所有调用秒回缓存。两个调用点(Discover 路径 + spawn 路径)无论谁先触发,
只 spawn 一次 shell。

**明确不做的增强(用户拍板):**
- 不持久化缓存到 SQLite(V2)、不用 `.zshrc` mtime 做 SWR 失效(V3)——坚决不碰
  用户文档;一次解析 ~100-500ms,VS Code 也只做进程内 Once 缓存,够用。
- 不接 `Spec.ExtraDirs`(shellenv 拿到完整 PATH 后它纯冗余,只在 shell 坏时兜底,
  edge case 不值得)。
- spawn 不改用绝对路径(PATH 修好后 spawn 本来就能找到,绝对路径是过度健壮性)。

**创建对话不预检 harness**:`CreateSession`(`chat.go:564`)只写 DB,永不 spawn,
必然成功;spawn 是惰性的(`ensureLive`,发消息时才触发)。harness 装不装都能先建
对话,装好后回来 resume 即可(§1.4 session 可恢复)。这已是现有架构的事实行为,
无需改动。

## 改法(3 处,1 个新包)

1. **新包 `internal/shellenv`**(`shellenv.go` + `shellenv_test.go`):
   - `Resolve(ctx) error`:幂等。Windows no-op;darwin/linux 生效。
   - `pickShell`:`$SHELL`(非 /bin/false/nologin)→ darwin `/bin/zsh` / 其它 `/bin/bash`。
   - `captureShellEnv`:`<shell> -i -l -c 'echo <mark>; env'`(tcsh/csh 用 `-ic`);
     **预算彻底脱离调用方 ctx**——`doResolve` 不接 caller ctx,自己从
     `context.Background()` 派生 10s 预算传入。关键:结果经 `sync.Once` 缓存整个进程,
     若用 `context.WithTimeout(callerCtx, budget)`(取 min)或让 caller 取消传播进来,
     一个短命 caller(Discover 的 5s ctx)超时/取消 → 缓存失败 → spawnAndInit
     (长命 ctx)继承失败、用户再也起不了 session。脱离 caller ctx 才能保证缓存的是
     真实结果;子 shell 传精简 env(HOME/USER/TERM=dumb + `GIT_TERMINAL_PROMPT=0`
     防挂起 + sentinel `MONKEY_DECK_RESOLVING_ENV=1` 供 rc guard)。
   - `parseAfterMarker`:marker 分隔,只信 marker 之后的 `KEY=VALUE` 行,过滤 sentinel。
   - 可注入缝 `pickShellFn`/`captureShellEnvFn`(§5.1)+ `resetForTest`(测试多次跑)。
   - **踩到的并发 bug**(见下)。

2. **接入点1** `internal/chat/chat.go` `refreshHarnessesAsync`:Discover 前加
   `_ = shellenv.Resolve(ctx)`(失败静默降级,Discover 照常跑)。

3. **接入点2 + 友好错误** `internal/acp/runner.go` `spawnAndInit`:`Start()` 前加
   `shellenv.Resolve`;`cmd.Start()` 失败时若 `errors.Is(err, exec.ErrNotFound)` 包成
   人话「找不到 X 命令,请确认该 harness 已安装…」(§4.4 禁止裸技术格式)。

## 踩到的坑(写进 AGENTS.md §5.4)

**`Resolve` 并发 bug——`sync.Once` + 局部 channel = 后续调用方永久阻塞。**

初版用 `once.Do(func(){ c <- doResolve(ctx) })` + 局部 `c := make(chan error, 1)`,
然后 `err := <-c`。问题:`once.Do` 只让**第一个** goroutine 进闭包写 `c`;其它
goroutine 不进闭包,却都执行到 `err := <-c` 去读一个**永远没人写的 channel**
(只有进闭包的那个 goroutine 持有 `c` 的写入侧)→ 9 个 goroutine 永久阻塞,
单测 `TestResolve_Idempotent_OnlyOneSpawn` 直接超时。

**修法(找不变量,不堆 if,§5.3)**:所有调用方读**同一份共享结果字段**(`resErr`/
`didRun`,由 `resMu` 保护),不存在 per-goroutine 的 channel。流程:
- fast path:`didRun` 为真 → 直接返 `resErr`(RWMutex 读锁)。
- slow path:`once.Do(func(){ 算 → 写 resErr/didRun })`;所有调用方出 `once.Do` 后
  从共享字段读结果。`once.Do` 本身是 full barrier,保证可见性。

教训:并发原语组合要验证"谁是生产者、谁是消费者、channel 谁能拿到引用"。
`once` + 局部 channel 是经典反模式——消费者集合 ≠ 生产者集合。

## 改了哪些文件

- `internal/shellenv/shellenv.go`(新增)
- `internal/shellenv/shellenv_test.go`(新增)
- `internal/chat/chat.go`(import + `refreshHarnessesAsync` 加一行)
- `internal/acp/runner.go`(import errors/shellenv + `spawnAndInit` 加 Resolve + ErrNotFound 友好提示)

## 验证

- `go build ./...` 通过。
- `go test ./internal/shellenv/ -race -timeout 30s` 全绿(含 race;覆盖纯函数 +
  注入 fake 的 doResolve:成功改 PATH / 无 PATH 不改 / shell 报错 / 无可用 shell /
  幂等只 spawn 一次 / 缓存 error / ctx 取消 / childEnv 不泄漏 GUI junk)。
- `go test ./...` 全绿。
- `go vet ./internal/shellenv/ ./internal/acp/ ./internal/chat/` 干净。

## 下一步

- 实机验证:打 release 包 → Finder 双击启动 → 确认 harness 列表非空 + 能发消息。
- (可选)若 shellenv 在某些用户的怪 shell 上失败,考虑加 UI 兜底:检测到全部
  harness 都 `!Installed` 时提示「可能是 PATH 问题,请确认从终端启动或已安装」。
  当前失败静默 + spawn 时的人话提示已够,UI 兜底非必须。
