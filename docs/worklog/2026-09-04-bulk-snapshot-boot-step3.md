# 步3 F3：ListAllSessions + ListPoppedSessions 批量快照 boot 路径（原子 commit）

> 上游：[2026-09-03-runtime-request-storm-final-plan.md](./2026-09-03-runtime-request-storm-final-plan.md)。四步方案第 3 步——**与批量 popout 查询不可拆分**（单独上 ListAllSessions 会引爆 432 地雷，见定稿方案 R2 评审）。

## 起因

步 1/2 之后 boot 仍有 31 个 `ListSessions`（线性）+ popout 对账隐患：旧对账 effect 在「首批数据到达」即落闸（`popoutReconciledRef`），若数据一次性 bulk 落地（本步引入），首批=全量 432 session → 对账会打 **432 次 `IsSessionWindowPopped`**（GUI 也中招）。两个 binding 必须同 commit 上。

## 改法

**后端**（§1.7 胖后端，§5.3 单一真相源）：
- `store.ListAllSessions(ctx)`：全表 `ORDER BY project_id, pinned DESC, prompted_at DESC, updated_at DESC` 一次查询按项目分组；**契约：每个项目必有键、值恒非 nil**（空项目 = `[]Session{}`）——nil slice 会序列化成 JSON null，破坏前端「sessionsByProject 值恒为数组」不变量。
- `ChatService.ListAllSessions()` binding 转发。
- `ChatService.ListPoppedSessions(sessionIDs []string) []string`：复用 `popoutWindowName` + `GetByName`（与单数版同一真相源，零语义漂移），返回非 nil。

**前端**：
- boot 快路径：mount 发 **1 次** `ListAllSessions`，`setSessionsByProject` 按 key 合并；`snapshotSettled` state 门控旧逐项目循环（快照在途时 fallback 不启动，避免 31 连发竞速）。
- 旧逐项目循环**保留为 fallback**（快照失败/新增项目/单项目重试），happy path 下 0 请求。
- popout 对账重写：gate 从「首批非空」改为 **`allLoaded`**（`projectsRef.every(p => p.id in sessionsByProjectRef)`，deps 加 `projects`），批量调用一次 `ListPoppedSessions`。allLoaded 在快照成功与 fallback 回填两条路径下都只在真正齐全时为真——`snapshotSettled` 不行（finally 置位，失败回填中途会提前放行，地雷换路径保留）。

**bindings**：`wails3 generate bindings` 重跑。⚠ 本机 PATH 上的 wails3（beta.16）与 go.mod（alpha2.106）不同线，已改用 `/tmp/md-wails-bin/wails3`（`go install …@v3.0.0-alpha2.106`）生成；新版生成器输出 .js（无 .ts），tsc+Vite 构建实测通过。旧 .ts 树是历史遗留（bindings 不入库），Taskfile 的 gen 任务在任意机器再生成本就得到当前格式。

## 改动文件

- `internal/store/sessions.go`：`ListAllSessions`。
- `internal/store/listall_test.go`（新增）：T5b 契约测试（键集=项目集、空项目非 nil 空数组、逐项目深度相等、pinned 排序）。
- `internal/chat/chat.go` / `internal/chat/window.go`：两个新 binding。
- `frontend/src/App.tsx`：快路径 + fallback 门控 + 对账重写。
- `frontend/src/App.boot-budget.mount.test.tsx`：T5/T6/T7/T13 新增，T1-T4 改造（bulk 桩）。
- 4 个存量 mount 测试的静态桩列表补 `ListAllSessions`/`ListPoppedSessions`（新 binding 缺桩会让对账 effect 同步炸渲染树）。

## 验证

- **T5**（等价金标准）：bulk 桩 vs 逐项目桩（同数据、p01 含 pinned 双会话）→ 两种模式下 `ListPoppedSessions` 收到的全量 sid 序列**逐元素相等**（含 pinned 首位）。
- **T6**（防 432 地雷）：happy boot `IsSessionWindowPopped` === 0、`ListPoppedSessions` === 1。
- **T7**（fallback）：bulk reject → 31 项目仍全部逐项目加载。
- **T13**（对账语义）：`ListPoppedSessions` 返回 `["s-p01"]` → 侧栏该行出现 popout 标记、邻项目无——`poppedSessionIds` 正确落种。
- **T2 更新**：happy path 恰 1 次 `ListAllSessions`、0 次 `ListSessions`、1 次 `ListPoppedSessions`(28 sid)。
- **T1/T3/T4 更新**：bulk 降级场景下逐项目守卫语义不变。
- Go：`internal/store` 契约测试过；`go test ./...` 0 FAIL；`go build`（默认 + `-tags server`）双过。
- 前端：`bun test --isolate` 全量 **554 测试 0 失败**（注意：mount 测试必须 `--isolate`，与 package.json 一致；不带 isolate 的跨文件污染是既有现象，与本改动无关）。
- 三端：共享 boot 路径三端同跑；真机/浏览器实测量（含 432 session payload 字节数）在收尾 E2E 条目记录。

## 下一步

步 4（F2(ii)：resync 合流 + `selectedProjectIdRef`）→ E2E（server 二进制真数据浏览器计数）。
