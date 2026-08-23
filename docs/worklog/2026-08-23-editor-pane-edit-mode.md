# 2026-08-23 文件预览编辑模式(EditorPane edit mode)

## 起因

文件预览面板(EditorPane)此前是纯只读(CodeViewer 高亮查看 + 图片预览)。桌面客户端「有人在场」,对 agent 改完的文件想顺手小修一行时只能切外部编辑器。本次给文本文件加一条**人工编辑便捷路径**:gutter 行号 + textarea 编辑面、⌘S 保存、磁盘冲突防护、按路径草稿缓存。agent 侧的代码改动仍走 ACP(§1.1 不变),这只是 human-at-the-desk 的补充通道。

## 改法

### 后端(internal/fsview + internal/chat)

- `ReadFile` 返回值从裸 `string` 改为结构化 `FileData{Content, Binary, TooLarge}`:二进制/过大文件不再返回占位字符串("二进制文件,不预览。"),前端按类型化字段判断——转换层不丢弃语义(§5.3),也避免前端匹配提示文案的脆弱契约。
- 新增 `WriteFile(root, rel, content)`:safeJoin 钉路径防越界;2MB 上限(maxWriteSize,与 maxReadSize 对称);保留既有文件权限位;MkdirAll 兜底父目录。
- chat service:`SessionReadFile` 适配 FileData;新增导出方法 `SessionWriteFile`(已 `wails3 gen bindings`)。

### 前端(EditorPane.tsx + i18n + css)

- 编辑态:Pencil 进入,gutter + textarea(样式对齐 CodeViewer 度量,mono 12px/19px);dirty 为派生值(`draft !== content`),不存独立状态防漂移。
- ⌘S/Ctrl+S 保存;Esc 分层退出(先关横幅→脏时确认→退出);Tab 插 2 空格软缩进(默认 Tab 会把焦点移出编辑器)。
- **磁盘冲突防护**:保存前重读比对加载快照,不一致(agent 在同一 worktree 写入)则拒绝覆盖并弹「覆盖 / 重载 / 继续编辑」横幅。读-写天然 TOCTOU,force 路径即显式兜底。
- **按 `${sessionId}/${path}` 草稿缓存**:切 tab 中途不丢未保存内容。⚠ key 必须含 sessionId——相对路径跨 session(session=worktree)碰撞,纯 path key 会把草稿(及其保存目标)泄漏进另一 session 同名文件(review 发现后修复)。

## Review 结论(本次提交前的独立 review)

- 修 #1:草稿缓存 key 补 sessionId(上述泄漏 bug)。
- 修 #2:WriteFile 新增错误串转英文("is a directory",§3.7)。
- 接受:savedFlash 定时器未清理(unmount 后 setState 无害);冲突检查 TOCTOU(force 横幅为预期缓解)。

## 测试基建坑(bun test 共享模块注册表)

新 mount 测试用 `mock.module` 替换 chatservice binding 后,**同进程先加载的其他测试文件(ChatView/Composer)经 live ESM binding 看到替换**,缺导出直接炸(McpChip → GetSessionMcpServers "is not a function"),全套件 48 fail。Proxy fallback 无效(bun 复制自有可枚举键,proxy 丢失)。最终解法:**解析真实生成的 binding 文件提取全部导出函数名,未覆写的都注册为 no-op**(undefined 对调用方优雅降级)。修后全套件仅剩 HEAD 基线已有的 5 个 NewSessionModal 既有失败,零新增。

## 改动文件

- internal/fsview/fsview.go(FileData + WriteFile)、fsview_test.go
- internal/chat/chat.go(SessionReadFile 适配 + SessionWriteFile)
- frontend/bindings/...(gen bindings 产物)
- frontend/src/components/EditorPane.tsx、EditorPane.edit.mount.test.tsx(新)
- frontend/src/i18n/locales/{en,zh}.json、frontend/src/index.css

## 验证

- `go build ./...` + `go test ./internal/fsview/ ./internal/chat/` 通过。
- `bunx tsc --noEmit` 通过;EditorPane.edit.mount.test.tsx 5/5;全前端套件无新增失败(剩 5 个为 HEAD 既有)。
- gofmt -l 大量文件为仓库级既有漂移(注释对齐风格),未夹带处理。

## 下一步

- 排查既有的 bun test 跨文件 mock.module 污染(HEAD 上 HarnessPane/SidePanel 等 14 个失败疑似同源调度抖动)。
- 仓库级 gofmt 漂移单独清理(独立 commit)。
