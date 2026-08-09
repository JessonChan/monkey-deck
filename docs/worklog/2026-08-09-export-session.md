# 2026-08-09 ExportSession 后端导出 + Sidebar 右键导出菜单 + Blob 下载

## 起因
Task #24206:给 session 加「导出对话」能力。后端出一个 `ExportSession(sid, format)`
方法,支持两种格式:`jsonl`(每行一个 JSON,机器可读)和 `txt`(人话可读)。前端在
Sidebar session 右键菜单加导出入口,用 Blob 触发浏览器原生下载,文件名带标题 + id 前缀。

## 根因 / 设计
- **导出是纯读库操作**:对话真相来源是 SQLite 的 messages 表(§1.5),不需要走 ACP /
  不需要 spawn harness。直接 `GetSession + ListMessages` 即可,与 `LoadMessages` 同源。
- **两种格式定位不同**:
  - `jsonl`:机器可读,首行 session 元信息(`type:"session"`),后续每行一条消息
    (`type:"message"`,含 seq/role/kind/content/toolCallId/createdAt),按 seq 升序。
    适合二次处理 / 备份 / 导入其它工具。
  - `txt`:人话可读,遵守 §4.4(禁止裸露结构化格式)。user/thought/agent 各自分节
    (`─── You ───`);tool 不吐原始 toolAccum JSON,而是抽 title/status/主文本
    (`extractMainText`:string 直用、对象转缩进 JSON);plan 渲染成 checklist
    (`[x] completed` / `[~] in_progress` / `[ ] pending`)。
- **前端 Blob 下载**:标准 `Blob + URL.createObjectURL + <a download>` 模式,WKWebView /
  WebView2 / 浏览器都支持;纯客户端,导出文本拿到后不再回后端。文件名
  `<sanitize(title)|"session">-<id8>.<ext>`,跨平台文件名清洗(去 `\/:*?"<>|` 与控制字符)。
- **菜单形态**:session 右键菜单复用现有扁平 `ctx-menu`(项目里没有 submenu 模式,KISS),
  用 `ctx-label`(小号大写 label)+ 两个 `ctx-item`(FileText / Braces 图标)做一组导出。

## 改法
1. **`internal/chat/export.go`(新)**:`ExportSession(sessionID, format)` 导出方法 + jsonl/txt
   渲染 + `extractMainText` / `writeToolSection` / `writePlanSection` 等纯函数。format 空 / "txt" /
   "jsonl" 三态;其它显式报错。
2. **`internal/chat/export_test.go`(新)**:7 个单测覆盖 jsonl(首行 meta + 升序 seq + 每行合法
   JSON)、txt(分节存在 / tool 抽主文本不漏 rawOutput JSON key / plan checklist 标记)、
   空 session(两格式各自降级)、不存在 session、不支持格式、空格式默认 txt。用临时 store,
   不启真 harness(§5.1)。
3. **`frontend/src/lib/download.ts`(新)**:`downloadText(content, filename, mime)` Blob 下载 helper。
4. **`frontend/src/utils.ts`**:加 `sanitizeFileName`(跨平台文件名清洗)。
5. **`frontend/src/components/Sidebar.tsx`**:session 右键菜单加「Export chat」分组(txt / jsonl
   两项,带 `data-testid`);`onExportSession` 调 `ChatService.ExportSession` + `downloadText`,
   失败 `alert`(§4.4 人话提示)。
6. **`frontend/src/index.css`**:加 `.ctx-label`(小号大写分组标签)。
7. **i18n**:en/zh 各加 `sidebar.exportChat` / `exportAsText` / `exportAsJSON` / `exportFailed`。

## 改了哪些文件
- `internal/chat/export.go`(新)
- `internal/chat/export_test.go`(新)
- `frontend/src/lib/download.ts`(新)
- `frontend/src/utils.ts`
- `frontend/src/components/Sidebar.tsx`
- `frontend/src/index.css`
- `frontend/src/i18n/locales/en.json`
- `frontend/src/i18n/locales/zh.json`
- `docs/worklog/2026-08-09-export-session.md`(本条)

## 验证
- `go build ./internal/...` / `go build ./...`(含 frontend/dist)通过。
- `go vet ./...` 干净。
- `go test ./internal/chat/ ./internal/store/` 全绿;新增 7 个 ExportSession 单测全过。
- `wails3 generate bindings` 重新生成(含 ExportSession),`ExportSession` 已出现在 chatservice.js。
- `cd frontend && npm run build`(= `tsc && vite build`)通过,无 TS / 编译错误。
- `cd frontend && bun test src/i18n/locales.test.ts` 通过(en/zh 键齐)。
  (其余 frontend mount 测试的失败是既有 ChatService binding mock 问题,与本次改动无关 ——
  无任何测试触及 Sidebar 导出菜单 / download.ts。)

## 下一步
- 桌面 app 实测:右键 session → 导出 txt / jsonl,下载文件内容正确、文件名清洗生效。
- macOS WebKit + Win WebView2 跨平台抽检(§4.6):Blob 下载、文件名、ctx-label 样式。
