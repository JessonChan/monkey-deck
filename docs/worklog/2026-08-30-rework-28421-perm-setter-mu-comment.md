# 2026-08-30 返工 #28418 复审项:SetPermissionRecovery 补 mu + 注释如实

## 起因

Task #28421:返工复审卡 #28420(docs/worklog/2026-08-30-review-28418-perm-deny-backend.md)
的两项(1×P2 阻塞,1×P3 顺手),均为同步硬化+注释修正,行为语义零变化。基线 main=b147da0。

## 根因

**P2(阻塞)**:`handler.go` 的 `SetPermissionRecovery` 是全仓唯一不加 mu 的 setter——
`permRetries`/`permTimeoutPolicy` 两行赋值裸写;读侧(`RequestPermission` :440 读
`permRetries`、:493 读 `permTimeoutPolicy`)在 ACP reader goroutine 上裸读,写读之间无
Go 内存模型 happens-before 边,formal data race 成立(时序上 startLive 先于 Prompt,无真
并发窗口,故现网不可见)。仓库自留的 OPEN 条件已触发:docs/worklog/2026-08-06-elicitation-
callback-data-race.md:70-73 记录该裸写模式「等它接 DB/设置 UI」,0710caf 恰是那一 commit。

**P3**:`SetPermissionRecovery` 文档称「空串保留默认」已失实——#28418 把出厂默认翻为
deny 后,空串实际经 `timeoutPolicyAllow("")` 归 **allow**(与零值语义一致),注释未随
翻转同步。全仓无 caller 传空串(生产唯一 caller chat.go:1686 传归一值),偏差不可达,
故为文档硬化而非行为 bug。

## 改法

- **P2**:setter 内 `h.mu.Lock()/Unlock()` 包住两行赋值,对齐 sibling 五 setter
  (`SetGlobalRule`/`SetElicitationResolved`/`SetElicitationUnrenderable`/`SetCommandsCache`
  走 `h.mu`,`SetProjectAllowExternal`/`SetPermissionRules` 走 atomic)。修后 chat.go:1685
  注释「mu 对齐写」自动为真,该行未改动。
- **P3**:setter 文档改为如实描述:「空串/未知视作 allow(与零值语义一致),chat 装配层
  负责归一(normalizePermTimeoutPolicy)」。
- **禁改项均未动**:`timeoutPolicyAllow`、`normalizePermTimeoutPolicy`、行为语义零变化;
  纯 4 行级同步 + 注释硬化(实际 diff:+4/-1)。

## 改了哪些文件

- `internal/acp/handler.go`:`SetPermissionRecovery`(:330-341)加 mu 包裹赋值 + 文档注释修正。

## 验证

- `go build ./...` ✅;`go vet ./...` ✅(ld "newer macOS version" warning 为环境级 SDK
  噪音,与改动无关,与复审卡一致)。
- `go test ./...` ✅ **15/15 包全 ok**(acp 3.46s、chat 20.82s、store 2.61s 等,0 fail)。
- **race 佐证**:`go test -race ./internal/acp/` ✅ ok 4.34s。
- 定向 verbose:权限恢复 4 测全 PASS——`TestPermissionTimeoutDegradeDeny` /
  `DegradeDenyNoRejectOption` / `DefaultsToDeny` / `WiredDefaultsDeny`(0.20-0.40s each),
  行为语义零变化由此夹住。
- 前置环境补齐(与复审卡相同,非代码问题):新 worktree 缺 gitignored
  `frontend/dist` + `frontend/bindings` → `bun install` + `wails3 generate bindings
  -clean=true -ts -i`(297 packages/128 methods,与复审卡数字一致)+ `bun run build` ✅。

## 三端说明(§4.7)

纯后端改动(单文件 setter 同步+注释):后端能力统一实证一次(go test 全绿 + race ok);
未触碰前端代码,binding 签名零变化(bindings 重新生成仅是构建前置产物)。

## 下一步 / OPEN

- 无。复审两项全部关闭;不 push,不关 issue,停 completed-ready。
