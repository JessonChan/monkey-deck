# 2026-08-02 clipboard-copy-wails3-runtime

## 起因

全站 ~15 处按钮触发的复制(session ID / 文件路径 / 工作目录 / 工具 I/O / 代码块 /
mermaid 源码 / 分支名 / 预览内容等)全部不生效。Ctrl+C(选中文本后系统快捷键)正常。

## 根因

所有复制调用都用 `navigator.clipboard.writeText()`,且全部 `catch { /* noop */ }` 静默吞错。

`navigator.clipboard.writeText()` 在 Wails3 webview(WKWebView / WebView2)下不可用——
webview 不满足 secure context + user activation 的剪贴板写权限条件,调用抛
NotAllowedError / TypeError,被 `catch { /* noop */ }` 吞掉 → 用户点按钮无任何反应。

Ctrl+C 可用:走原生 OS 剪贴板(webview 内建文本选择 → 系统快捷键),不经 JS Clipboard API。

## 改法

1. **新建统一工具函数** `frontend/src/lib/clipboard.ts` → `copyText(text)`:
   - 优先 `Clipboard.SetText(text)`(**Wails3 runtime 原生剪贴板,webview 内可靠**)。
   - fallback `navigator.clipboard.writeText(text)`(纯浏览器 dev / server 模式)。
   - last resort `document.execCommand("copy")`(隐藏 textarea + 选区拷贝)。
   - 全程 try/catch,**永不抛错**——调用处不再需要自己的 try/catch。
2. **全站机械替换**:所有 `navigator.clipboard.writeText(x)` / `navigator.clipboard?.writeText(x)`
   → `copyText(x)`(import 自 `lib/clipboard`);删除各调用处的 `catch { /* noop */ }`,
   保留 `copied` ✓ 反馈。
3. **API 签名修正**:bug 报告里猜的是 `Clipboard.setText(text)`(camelCase)——实测
   `@wailsio/runtime` 导出的是 **`Clipboard.SetText(text)`(PascalCase)**,返回
   `Promise<void>`(见 `node_modules/@wailsio/runtime/types/clipboard.d.ts`)。按正确签名实现。

## 改了哪些文件

- `frontend/src/lib/clipboard.ts`(**新增**)——统一 `copyText` 工具函数。
- `frontend/src/components/ChatView.tsx`——5 处(路径复制 / 消息复制 / 工具 I/O ×2 / bash 命令 / 代码块源码)。
- `frontend/src/components/CopyIconButton.tsx`——通用复制按钮(多处复用)。
- `frontend/src/components/CollapsibleText.tsx`——折叠文本复制。
- `frontend/src/components/Composer.tsx`——分支名复制。
- `frontend/src/components/FilePanel.tsx`——2 处(预览内容 / 右键复制路径)。
- `frontend/src/components/FilePreviewOverlay.tsx`——预览内容复制。
- `frontend/src/components/MermaidRenderer.tsx`——mermaid 源码复制。
- `frontend/src/components/Sidebar.tsx`——3 处(项目路径 / session ID / 工作目录)。

## 验证

- `bun run tsc --noEmit` 通过(零 error)。
- `grep navigator.clipboard frontend/src` 仅剩 `lib/clipboard.ts` 内部(fallback + 注释),
  所有业务调用点已清零。
- `bun run test`:唯一失败 `McpChip.tsx`(ChatService.GetSessionMcpServers binding 未生成)
  是 **pre-existing**(clean main 上同样失败,与本次改动无关)。
- 桌面 app 实测待做(Wails3 dev 下点各复制按钮验证写入剪贴板)。

## 下一步

- 桌面 app(wails3 dev)实测各复制按钮 → 粘贴验证内容正确。
- 若后续 Wails3 升级 runtime,确认 `Clipboard.SetText` 签名未变。
