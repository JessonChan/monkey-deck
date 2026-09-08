# 2026-09-08 #207 CI windows proc 平台拆分 review(APPROVE)

## 背景 / 起因

审 #29035 实现(已合 main:c0a4bd2 fix(ci) + ea839cf worklog)。断言本机独立
复现,不采信 commit 叙事:六条断言逐条从证据重推(交叉编译、全量测试、
逐行 diff 对照 git 历史)。

## 结论:**APPROVE**(①–⑥ 全过,零 needs changes)

### ① GOOS=windows 本机交叉编译通过 ✓

- 前置:checkout 态无 `frontend/dist`,首轮 `GOOS=windows go build . ./internal/...`
  爆 `main.go:22:12: pattern all:frontend/dist: no matching files found`
  —— embed 缺失先于 proc 层,属 #203 已定性问题。按 ci.yml:46-48 逐字
  复刻 stub(`mkdir -p frontend/dist && echo stub > frontend/dist/index.html`)后:
- `GOOS=windows GOARCH=amd64 go build . ./internal/...` **exit 0**(与 CI
  windows 腿 Build backend 命令逐字一致)。
- 超集验证:`GOOS=windows go vet ./internal/...` **exit 0**——vet 类型检查
  含 `_test.go`,证明 CI windows 腿 `Test compile (no run)` 步
  (`go test -run xxx_none ./internal/...`)也能编译过(本机交叉态无法执行
  PE 二进制,`exec format error` 发生在运行阶段而非编译阶段,不构成失败)。

### ② darwin 本机 build + vet + go test 全量零回归 ✓

- `go build . ./internal/...` 过;`go vet ./...` exit 0 零输出。
- `go test ./...` exit 0:**15 包 ok,零 FAIL**。
- 受影响两包 `-count=1` 强制真跑(不吃测试缓存):
  `internal/acp` 27.7s ok(proc_exit/proc_pgidfile 等进程组行为测试实跑)、
  `internal/terminal` 0.77s ok。

### ③ unix 侧语义零改动红线 ✓(逐行对照 c0a4bd2~1)

| 旧内联(proc.go@c0a4bd2~1) | 新落点 | 对照 |
|---|---|---|
| setProcGroup :43-48 | proc_unix.go:15-20 | 逐字同(SysProcAttr nil 守卫 + Setpgid=true) |
| termGroup :67-71 | proc_unix.go:23-27 | 逐字同(`Kill(-pgid,SIGTERM)`+isNoProcess 过滤+同款 Warn) |
| killGroup :73-77 | proc_unix.go:30-34 | 逐字同(`Kill(-pgid,SIGKILL)`) |
| groupAlive :79-81 | proc_unix.go:37-39 | 逐字同(`kill(-pgid,0)==nil` 活性探测) |
| isNoProcess :83-85 | proc_unix.go:52-54 | 逐字同(ESRCH) |
| signalGroupDead :53-65 | proc.go:48-60 | 流程原样留编排层:TERM→3s deadline/100ms 轮询 groupAlive→killGroup |
| IsAlive 内联 `Signal(0)` :158 | proc_unix.go:43 probeAlive | 表达式逐字同;IsAlive(proc.go:127-136)改调 helper,alive 快路径不变 |
| reapStrayHarnesses 内联 `Kill(pid,SIGKILL)` :367 | proc_unix.go:48 killProcessHard | 调用点 proc.go:344 `err := killProcessHard(p.pid)` + isNoProcess,语义同 |
| KillAllHarnesses killGroup 调用 :409 | proc.go:386 | 不变 |

terminal 侧:旧 service.go:286-287 内联(`Getpgid` 成功→`Kill(-pgid,SIGKILL)`,
失败降级 `Process.Kill()`)逐字落 proc_unix.go:14-20;kill() 的
ptmx Close→killProcessGroup 顺序不变(service.go:284-290)。

### ④ proc_windows.go 单进程退化 + 限制注明 + 无组 API 泄入 ✓

- termGroup/killGroup → `killSingleProcess`(os.FindProcess+`Process.Kill`,
  ErrProcessDone 容忍);killProcessHard 同款;文件头 :13-24 注明首版限制
  (整组不可回收→组内子孙孤儿、SIGTERM→SIGKILL 塌缩一次 TerminateProcess)
  + `TODO(#207) Job Objects`。
- 泄入检查:文件内 syscall 用法仅 `OpenProcess(SYNCHRONIZE)`/
  `WaitForSingleObject(0)`/`CloseHandle`——单进程 Windows API,无任何
  进程组概念。probeAlive 走 pidAlive(OpenProcess 探活),规避了
  `Signal(0)` 在 windows 恒 EWINDOWS 的语义陷阱(worklog §规格外1 实证)。
- terminal/proc_windows.go:13-15 退化只杀 shell 主进程,限制注释 +
  同款 TODO。

### ⑤ 全仓裸 syscall 进程 API 仅存于平台文件 ✓

- `grep -r 'syscall\.(Kill|Getpgid|Setpgid)|Setpgid|Signal\(0\)'`:代码命中
  仅 `internal/acp/proc_unix.go`、`internal/terminal/proc_unix.go`;
  service.go/runner.go 等非平台文件零残留(service.go 的 `syscall` import
  已随之移除,git diff 实证)。
- proc.go 残留唯一 syscall 用法 = exitCodeSignal 的 `syscall.WaitStatus`
  类型断言(proc.go:146)——可移植类型,windows 有 invented 定义
  (`Signaled()` 恒 false),非进程组 API,worklog §规格外2 已实证免拆。
- 其余命中全在 docs/(worklog/AGENTS/PROCESS 文档),非代码。

### ⑥ worklog 落位 + windows 退化语义记录 ✓

- ea839cf → `docs/worklog/2026-09-08-ci-windows-proc-split-207.md`(59 行):
  基线 7 错调用点清单、拆分改法、**windows 退化语义完整记录**(单进程
  Kill/孤儿限制/TERM→KILL 塌缩/Job Objects TODO/terminal 侧退化/
  windows 无 ps → reaper 安全 no-op),与实际 diff 逐项一致。

## 反「类型补丁」核验(逐消费点追踪)

helper 无一空壳,全部有真实调用点:signalGroupDead→termGroup/groupAlive/
killGroup(proc.go:49,52,58);IsAlive→probeAlive(proc.go:135);
reapStrayHarnesses→killProcessHard+isNoProcess(proc.go:344);
KillAllHarnesses→killGroup(proc.go:386);terminal kill→killProcessGroup
(service.go:288)。测试断言锚定行为(proc_exit_test 用进程组主 PID 直接
SIGKILL 模拟外部杀,run 后断 exit 根因分类),非字段存在性断言。

## 验证(全部本机复跑,2026-09-08)

- windows:`build . ./internal/...` exit 0 + `vet ./internal/...` exit 0
  (stub 按 ci.yml:46-48 逐字复刻;stub 与 dist 均被 gitignore,未混入)。
- darwin:build 过、vet exit 0、`go test ./...` 15 包 ok;受影响两包
  `-count=1` 真跑 ok。
- 三端说明:零前端改动,纯后端平台拆分,后端验证一次即可(§4.7)。

## 非阻塞观察(记录,不要求改)

- CI 对 windows 腿显式 skip vet(`if: matrix.goos != 'windows'`);经本次
  本地 windows vet(含测试文件)全绿实证,该 skip 现已无必要,未来可去掉
  让 windows 腿也跑 vet——本卡不动。
- windows 下 signalGroupDead 的 3s 轮询结构保留,但 pidAlive 在单进程
  Kill 后立即返 false,循环即刻退出——退化自洽,无行为风险。
- 本机 ld "newer macOS version (26.0)" warning 为工具链噪音(与 #203
  review 记录一致),非错误。

## 下一步 / 留人

- **CI 实跑绿留人**(Windows backend job);不 push、不关 issue。
- 上层复核本 APPROVE 后按 completed-ready 流转。
