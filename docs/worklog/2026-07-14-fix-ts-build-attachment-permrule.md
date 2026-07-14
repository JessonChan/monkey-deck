# 2026-07-14 修复前端 TS 编译错误(Attachment.path 可选 + PermissionRule 去 new)

## 起因
前端 `bun run build` 失败,4 个 TS 错误:
- `App.tsx:354/556/598`:发消息时图片附件构造为 `{ name, data, mimeType }`(无 path),但 `Attachment.path` 必填 → TS 报缺 path。
- `PermissionSettings.tsx:70`:`new PermissionRule({...})` 非法 —— `PermissionRule` 是 TS 类型不是可 `new` 的类(该处按类型用对象字面量即可)。

## 根因
- `Attachment` 的图片分支(Data 非空,发 ContentBlock::Image)本就不需要 Path,Path 只在文件 @提及分支(ResourceLink)用。Go struct 的 `Path` 字段没加 `omitempty`,wails3 生成的 binding 把 path 当必填,图片附件(合法用法)过不了类型检查。
- `CreatePermissionRule(rule)` 形参类型是 `PermissionRule`(结构化对象),前端直接传对象字面量即可,不需要 `new`。

## 改法
1. Go 侧 `internal/acp/runner.go` `Attachment.Path` 的 json tag 加 `omitempty`,重跑 `wails3 generate bindings`,生成 binding 里 path 变 `string | undefined`(可选)。
2. `frontend/src/components/PermissionSettings.tsx`:`new PermissionRule({...})` → 普通对象字面量 `{ level: "ask", enabled: true, sortOrder: rules.length }`。

## 改了哪些文件
- `internal/acp/runner.go`(Attachment.Path json tag +omitempty)。
- `frontend/src/components/PermissionSettings.tsx`(去 new PermissionRule,改对象字面量)。
- `frontend/bindings/...` 由 `wails3 generate bindings` 重新生成(gitignore,不入库)。

## 验证
- `go build ./...` / `go vet ./...` 通过(仅 macOS 链接器版本告警,非错误)。
- `go test ./...` 全绿。
- `frontend/` 下 `bun run build`(tsc + vite build)零 TS 错误、构建成功。
- `frontend/dist` stub 由 build 产出,满足 `//go:embed all:frontend/dist`。
- 确认生成 binding `models.js` 里 Attachment.path 为 `string | undefined`(omitempty 形态)。

## 下一步
无;本次纯修 build,不涉及行为变更。
