# 请求风暴修复的两个 OPEN 清算：CLI 钉版 + 列表投影瘦身

> 收尾自 [2026-09-04-request-storm-e2e-wrapup.md](./2026-09-04-request-storm-e2e-wrapup.md) 的 OPEN #1（payload 瘦身）与 #2（CLI 双线钉版）。

## OPEN #2：wails3 CLI 钉版（commit `80d908f`）

**起因**：PATH 的 wails3（beta.16）与 go.mod（alpha2.106）不同 release 线，两条线的生成器输出不兼容（.ts vs .js、map 值类型 `Session[]|null` vs 不透明 `{}`）——已实测咬人两次（`cb34126` 的跨线类型冲突、`wails3 task package` 再生成换格式）。

**改法**：两个 bindings 生成入口统一动态钉版——`build/Taskfile.yml` 的 `generate:bindings`（build/package 路径，带 `-ts -i` 等旗标）与根 `Taskfile.yml` 的 `bindings`（dev 路径，改为委托 common 任务）都改为 `go list -m | cut` 取 go.mod 的 wails 版本再 `go run …@<版本> generate bindings`。单一事实来源 = go.mod：升级 wails 只改 go.mod，bindings 自动跟随。AGENTS §0.5 已补「必须走 `wails3 task bindings`」的硬约束注记。

**验证**：`wails3 task bindings` 输出 `using wails3 v3.0.0-alpha2.106 (pinned to go.mod)`，bindings 恢复 .ts 格式（28 models 含新 map model）；`bun run build`（tsc）+ 15 个 boot 测试在 .ts bindings 下全绿（`cb34126` 的边界 cast 对两条线都成立的设计得到复验）。

**坑**：Taskfile 会先吃掉 Go 模板 `{{.Version}}`——取版本不能用 `go list -m -f '{{.Version}}'`，改用 `go list -m <mod> | cut -d' ' -f2`。

## OPEN #1：列表投影瘦身（本次 commit）

**起因**：`ListAllSessions` 真数据 payload 2.27MB（432 session），慢 WiFi 手机每次 boot/亮屏各拉一次。实测列权重：`config_options_cache` 1.48MB + `commands_cache` 0.31MB = **79%**；而前端对列表行的这两个字段**零消费**（缓存经 openSession 的专用 binding `GetSessionCachedConfigOptions`/`GetSessionCachedCommands` 按需拉取，grep 全仓证实）。

**改法**：`internal/store/sessions.go` 新增 `sessionListColumns`（两缓存列以 `'' AS …` 代换，保持列序/列数使 `scanSession` 单一形状）；`ListSessions` 与 `ListAllSessions` 共用该投影。`GetSession`/worktree 查询保持全列。Go 侧其余 `ListSessions` 消费者核实仅 `RemoveProject`（只读 WorktreePath，无碍）。

**契约测试**：`listall_test.go` 新增断言——两列表路径缓存列为空、`GetSession` 返回原值；`commands_cache_test.go` 的「列表也带缓存」旧断言更新为新契约（原契约无产品路径消费，属实现细节钉死）。

**E2E 复测（真数据）**：payload **2,275,263 → 262,406 字节（8.7×）**，31 键 / 432 session 不变；浏览器 boot 仍**恰 6 个** `/wails/runtime`（方法构成不变：ListProjects/ListAllSessions/ListHarnesses/ListHarnessCapabilities/ListTerminalsBySession/ListPoppedSessions 各 1）；侧栏 31 项目渲染正常。`go test ./...` 0 FAIL；`bun test --isolate` 561 测试 0 失败。

## 三端

- 桌面 GUI：共享 store 列表路径，IPC payload 同步变小（webview 内存/序列化双受益）；mount 测试覆盖。
- 远程浏览器：E2E 实测（上表）。
- PWA：同一服务；亮屏 resync 的快照从 2.27MB → 262KB（慢 WiFi 可感改善），真机计数待用户侧例行确认。

## 剩余 OPEN

wrap-up 条目中的 #3（SCM tab 冷态抖动，cosmetic，单开 issue）与 #4（`__mdRemote` 时序，最坏 1 次无害调用）保持不动。
