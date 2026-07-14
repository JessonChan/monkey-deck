# 终端图标改后端驱动(ListTerminalsBySession + term_state 事件)

## 起因
侧栏「已开终端」图标(Task #15437)上一版(见 `2026-07-14-sidebar-terminal-opened-marker.md`)
数据源是纯前端内存 state(`termOpenBySession`),只反映「面板是否展开」,不反映后端真实终端:
- 应用重启后图标全丢(`termOpenBySession` 是 useState,重启即失)。
- 打开历史 session / 跨 session 切换时,后端早已活着的终端不会点亮图标。
- 面板收起但终端仍活着 → 图标灭(语义错);面板开着但终端已死 → 图标亮(语义错)。

## 根因 / 设计
把数据源从「前端面板展开态」改成「后端权威的终端存在性」(§5.3 尊重数据源):

- **解耦两个语义**:
  - `termOpenBySession`(原有,保留):面板是否展开 = 本地 UI 态,只管面板显隐。
  - `hasTermBySession`(新增):该 session 是否仍有 ≥1 活跃终端 = 后端权威态,管侧栏图标。
  - 二者正交:面板可收起但终端仍活着(图标亮);反之面板开着但终端已死(图标灭)。
- **后端暴露**:`internal/terminal` 复用既有内存 `sessions` map(终端生命周期已在这管理),
  最小暴露两类出口:
  1. 查询接口 `ListTerminalsBySession() map[string]bool` —— 启动 / 打开列表时全量对账。
  2. 事件 `terminal:state`(payload `StatePayload{sessionId, hasTerminal}`)—— Start/Kill/
     KillSessionTerminals/自然退出时实时推送,前端订阅即时更新。
- **前端对账**:启动 useEffect 拉 `ListTerminalsBySession` 一次性同步,再订阅 `terminal:state`
  实时 patch;`createTerminal/closeTerminal` 仍本地乐观更新面板态,图标以后端事件为权威对账。
- **不变量**:不靠「上一个事件是什么类型」猜,而按 `sessionId` 主键 patch `hasTermBySession`
  ——同 session 多终端时,杀一个不误报归零(后端 `emitState` 锁内计数,有同胞就保持 true)。

## 改法
### 后端(`internal/terminal/service.go`)
- 新增常量 `EventState = "terminal:state"`、类型 `StatePayload`。
- `Start` / `Kill` / `KillSessionTerminals`(仅当有 kill)末尾各调一次 `emitState(sessionID)`。
- `readLoop` 自然退出收口时,**仅当本路径真正从 map 移除**才 `emitState`(kill 路径已删 +
  自己 emitState,这里跳过避免重复 + 防误报)。原 `delete` 改为「存在才删 + 标记 removed」。
- 新增 `ListTerminalsBySession()`:RLock 下遍历 sessions,按 sessionID 聚合 true 集合。
- 新增 `emitState`:RLock 下计数该 session 活跃终端数 → hasTerminal,锁外 emit。

### 后端测试(`internal/terminal/service_test.go`)
- `TestListTerminalsBySession`:查询接口反映活跃终端真实分布(同 session 多终端聚合、杀一个仍在)。
- `TestEmitStateOnStartAndKill`:Start → hasTerminal=true,Kill → hasTerminal=false。
- `TestEmitStateKeepsTrueWhenSiblingAlive`:同 session 两终端,杀一个**不得**误报 false。
- `waitForState` 轮询 helper。

### 前端(`frontend/src/App.tsx` + `components/Sidebar.tsx`)
- App.tsx 新增 `hasTermBySession` state + 启动对账 + `terminal:state` 订阅(useEffect,空依赖,
  挂载一次);Sidebar 透传从 `termOpenBySession` 改为 `hasTermBySession`。
- Sidebar.tsx prop 重命名 `termOpenBySession` → `hasTermBySession`,渲染条件随之改用。

## 改了哪些文件
- `internal/terminal/service.go`
- `internal/terminal/service_test.go`
- `frontend/src/App.tsx`
- `frontend/src/components/Sidebar.tsx`
- bindings 由 `wails3 generate bindings` 本机生成(不入库),已含 `ListTerminalsBySession`。

## 验证
- `go build ./... && go vet ./... && go test ./...` 全绿(terminal 包含 4 个新测试均 pass;
  ld 的 macOS 版本 warning 与本改动无关,是 SDK 提示)。
- `wails3 task build`(= regen bindings + 前端 `tsc && vite build` + Go production build)零 TS
  错误、产出二进制成功。
- dist stub(`frontend/dist/index.html`)已存在,`//go:embed all:frontend/dist` 通过。

## 下一步
- 手动 `wails3 dev`:开终端 → 侧栏图标亮;切走再切回图标仍在(后端权威,不再丢);关面板
  但终端活着 → 图标仍亮(语义修正);关掉最后一个终端 → 图标灭;重启应用 → 图标按后端真实
  终端复现(此前纯前端态会全丢)。
- 跨 session:session A 开终端、切到 B,B 图标不亮(A 的终端不影响 B)。
