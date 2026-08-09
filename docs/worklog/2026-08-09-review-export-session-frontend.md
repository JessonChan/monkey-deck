# 2026-08-09 Review #106 前端:Sidebar 右键导出菜单 + Blob 下载 + i18n (PASS)

**起因**:Task #24209 对 #24206 的**前端部分**(`frontend/src/`)做 fe-reviewer 复审。这是
**重跑**——上一轮 fe-review #24208 已完成审查并给出 PASS(APPROVE)结论,提交了 worklog +
一处 sanitizeFileName 注释英文化微修(refactor),但 merge 阶段 acceptance gate 失败(原因含
quota,属瞬时)。本轮在新分支上重跑核验 + 重新落地微修与 worklog,让分支落地。

范围:Sidebar.tsx session 右键导出菜单(JSONL / TXT)、`download.ts` Blob 下载、
`utils.ts` `sanitizeFileName`、zh/en i18n、与后端 `ExportSession` binding 对齐。
后端 `internal/chat/export.go` 已由 backend reviewer APPROVE(Task #24207),不在本审。

## 逐点核验(对应 Task 验收点 1–6)

1. **右键菜单导出项符合现有 ctx-menu 模式** ✅
   `Sidebar.tsx:490-498`:用扁平 `.ctx-menu` + 新增 `.ctx-label`(小号大写分组头)+
   两个 `.ctx-item`(`<FileText>` / `<Braces>` 图标 + 文案)+ `ctx-sep` 包夹。**无 submenu**
   (项目里无 submenu 模式,KISS,§5.3)。与同菜单的 Pin / Copy / Reveal 等兄弟项形态一致
   (都是 `<button class="ctx-item">` + 13px 图标 + 文案)。`.ctx-label` 是合理的分组原语,
   `index.css:322` 样式(10.5px uppercase letter-spacing)克制、与 `.ctx-sep` 协调。

2. **导出调用经 generated/bound client(不走 raw fetch/IPC)** ✅
   `Sidebar.tsx:209`:`await ChatService.ExportSession(sessionId, format)`,经 generated
   client(`frontend/src/bindings/.../chatservice.js`,`wails3 gen bindings` 产物)。
   **binding 签名对齐已核**:Go 端 `func (s *ChatService) ExportSession(sessionID, format string)
   (string, error)`(`internal/chat/export.go:24`)是 `*ChatService` 的导出方法;`main.go:51`
   `application.NewService(chatSvc)` 注册服务,Wails3 自动绑定。方法导出 / 服务注册 / 返回值
   Promise reject-on-error 三件对齐。无 raw fetch / 手写 IPC。

3. **Blob 下载构造正确;文件名清洗;空 title 不崩** ✅
   - `download.ts`:标准 `Blob + URL.createObjectURL + <a download>` 模式;`appendChild` →
     `click()` → `removeChild`,`setTimeout(revoke, 0)` 下 tick 回收(注释说明:部分 webview
     同步开始下载,过早 revoke 会截断慢引擎)。WKWebView / WebView2 / 浏览器通用。
   - MIME:txt `text/plain;charset=utf-8`;jsonl `application/x-ndjson;charset=utf-8`。
     Task 写「application/jsonl」是举例,`application/x-ndjson` 是 ndjson.org 的事实标准、
     比 `application/jsonl`(未注册)更准;Blob `download` 走文件名扩展名,MIME 不影响落盘。
     **非阻塞,反而更好。**
   - 文件名 `${sanitize(title) || "session"}-${id8}.${ext}`(`Sidebar.tsx:204-210`)。
     `sanitizeFileName`(`utils.ts:31-36`)覆盖 Windows `<>:"/\|?*` + Unix `/` + 控制字符
     (`\x00-\x1f`)+ 折叠空白 + trim。空 title → `"" || "session"` → `"session"`,**不崩**。
     `idPref = sessionId.slice(0, 8)`(sessionId 是 UUID,恒 ≥8 字符,无 §5.4 #3 safe-slice 风险)。

4. **空对话 / 后端返空串不报错、不下载空文件** ✅
   - **空对话**:后端契约保证 valid session 永不返空串——txt 恒有 header + `(no messages)`,
     jsonl 恒有首行 meta(backend reviewer 第 4 点已核 + 单测 `TestExportSession_*EmptySession`
     锁定)。前端拿到非空内容 → 正常下载小文件,**非错误**,符合预期。
   - **后端 error**(session not found / unsupported format / DB err):Go 返 `(="", err)` →
     binding Promise reject → 前端 `catch` → `alert(t("sidebar.exportFailed") + e)`。
     **不下载空文件**,给用户人话提示(§4.4)。
   - 唯一理论路径「valid session 但后端 bug 返 ""」:后端单测 + 契约锁定不可能,前端不额外
     查空可接受(§5.3 KISS,不为不可能路径加 if)。

5. **i18n:zh/en 同步,§4.4 人话** ✅
   `en.json:80-83` / `zh.json:80-83` 各加 4 key:`exportChat` / `exportAsText` / `exportAsJSON` /
   `exportFailed`,两侧 leaf key 完全一致(本审 grep 复核)。文案人话:「导出会话」「导出为
   文本 (.txt)」「导出为 JSON Lines (.jsonl)」「导出失败」——无 raw 字段名 / 协议串(§4.4)。

6. **无 TS 错误** ✅
   - `cd frontend && npm run build`(= `tsc && vite build`):clean,零 TS / 编译错误
     (仅 chunk-size 提示,既有、与本次无关)——见下方「验证复跑」。
   - `go build ./...`:exit 0。
   - locale test:green(见验证)。

## 可访问性(§4.2 / §4.5)

- **`data-testid`** ✅:`export-txt-${ctx.session.id}` / `export-jsonl-${ctx.session.id}`,
  锚定 session id(§4.2 测试友好;文本选择器会被同名项 / tab toggle 干扰)。
- **键盘导航** ✅:导出项是真 `<button>`,原生 focusable;菜单已有 Esc / 外部 click / resize
  关闭(`Sidebar.tsx:237-248`,§4.2)。
- **tooltip(§4.5)** ✅:导出按钮是「图标 + 完整可见文案」,非 icon-only;文案自解释
  (「Export as Text (.txt)」),与同菜单所有兄弟项(Pin / Copy / Reveal)一致——均无 tooltip。
  §4.5 针对「icon-only 按钮 / 被截断文本 / 状态指示」,导出项不属此类。**非阻塞。**

## 反模式排查(learning checklist)

- **类型补丁反模式**(字段加了没人消费):无新字段;`sanitizeFileName` 被 `onExportSession`
  立即消费拼文件名,`downloadText` 被 `onExportSession` 消费触发下载。全链路有消费端。✅
- **测试断言锚定值**:本次未加前端测试;locale test 是结构契约(leaf-key 集合相等),
  非易变全串锚定。导出菜单 / download.ts 的真集成验证靠桌面 app 实测(见「下一步」),
  与既有 frontend 测试策略一致(无 jsdom 模拟 Blob 下载的先例)。✅

## 本审微修(单独 commit,§6.2 原子提交)

- `frontend/src/utils.ts`:`sanitizeFileName` 的两行中文注释 → 英文(§3.7 硬约束:新增注释
  一律英文)。`download.ts` 与 Sidebar `onExportSession` 注释原本已是英文,utils.ts 漏了,
  本审顺手补齐(§3.7「碰到就要顺手转」)。纯注释,无逻辑变化,tsc 复跑 clean。
  (commit `4ea7d77`,与本文档 commit 分离,符合 §6.2「文档与代码分开 commit」。)

## 非阻塞观察(不修,记录备查)

1. **`alert()` 是全前端唯一一处**:其它错误走 modal 内 `setErr` / 面板内 inline error。
   导出是「一次性 ctx-menu 动作、无 modal 落点」,且无全局 toast 系统,`alert()` 是 KISS
   的可靠选择(WKWebView / WebView2 均支持);导出失败罕见(仅后端 error)。转 inline state
   属过度设计,保持 `alert()`。
2. **MIME 选 `application/x-ndjson`**:见核验点 3,比 Task 举例的 `application/jsonl` 更标准。

## 不变量 / 协议合规

- 导出是**纯客户端下载**:文本经 binding 拿到后不再回后端,无 ACP / 无 spawn harness(§1.1)。
- **§5.3 转换层不丢标识**:`onExportSession` 透传 `sessionId` / `title` / `format`,不做启发式
  推断;文件名拼接是确定性的(`sanitize || "session"` + id8 + ext)。
- **§4.4 不裸露结构化格式**:菜单文案、失败提示均人话;raw 错误对象经 `${e}` 串化附在提示后
  (排障用,非主信息)。

## Verdict:PASS(APPROVE)

前端导出菜单形态合规、binding 对齐、Blob 下载与文件名清洗正确、i18n 同步、build clean。
仅一处 §3.7 中文注释微修(单独 commit,tsc 复跑 clean),无 NEEDS CHANGES。

## 验证复跑(acceptance gate)

- `frontend/dist` stub(index.html)建好后 `go build ./...` 通过。
- `go vet ./...`:clean。
- `go test ./internal/chat/ ./internal/store/`:全绿,7 个 `TestExportSession_*` 全过。
- `cd frontend && npm run build`(= `tsc && vite build`):clean,零 TS 错误。
- `cd frontend && bun test src/i18n/locales.test.ts`:pass(zh/en leaf-key 同步)。

## 下一步

- 桌面 app 实测:右键 session → 导出 txt / jsonl,验证下载内容、文件名清洗、空 title 降级。
- macOS WebKit + Win WebView2 跨平台抽检(§4.6):Blob 下载行为、`.ctx-label` 样式、
  `alert()` 弹窗渲染。
