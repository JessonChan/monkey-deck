# 2026-07-21 修复 effort 切换 configId 硬编码

## 起因
Task #21292。`Composer.tsx` 的 `ModelSelect` 在切 model / mode / effort 时把
`configId` 写死成字符串:`onSetConfig("model"|"mode"|"effort", v)`。这条字符串最终原样
透传给 ACP `session/set_config_option` 的 `ConfigId` 字段(`runner.go:340` → `acp.SessionConfigId(configId)`)。

## 根因 / 协议调研
ACP `SessionConfigOption` 里 `id` 与 `category` 是**两个独立字段**:
- opencode 经诊断程序证实(`docs/PROCESS.md:213`):effort 的 `category="thought_level"`、`id="effort"`。
- model / mode 的 `id` 一般等于 `category`,但**这只是 opencode 的约定,不是协议保证**。

写死 `"effort"` 把「按 category 找 option」(`c.category === "thought_level"`)与
「给 ACP 回 `ConfigId`」(`onSetConfig("effort", ...)`)绑死成同一个字符串 ——
当 opencode 哪天换 id、或换一个 id ≠ category 的 harness 时,**热切会静默落空**
(ACP 找不到对应 configId,要么报错要么 no-op,用户切了不生效)。

## 改法
前端 `ConfigOption` 类型早就有 `id`(`types.ts:58`,后端 `handler.go:74` 已从
`o.Select.Id` 填充)。**直接用 option 自带的 `id`,不要重发明协议字段。**
(呼应 AGENTS.md §5.3「尊重数据源,转换层不丢弃标识」。)

- `modelOpt` → `onSetConfig(modelOpt.id, v)`
- `modeOpt`  → `onSetConfig(modeOpt.id, v)`
- `effortOpt` → `onSetConfig(effortOpt.id, v)`

**后端无需改动**:`ConfigOption.ID` 已存在,FlattenConfigOptions 早已透传。

## 改了哪些文件
- `frontend/src/components/Composer.tsx`(`ModelSelect` 3 处 `onSetConfig` 改用 `*.id`)
- `docs/worklog/2026-07-21-effort-config-id-hardcoded.md`(本条)

## 验证
- `./node_modules/.bin/tsc`:无新增 Composer.tsx 类型错误(仅剩预先存在的「bindings 模块未生成」编译错误,与本改动无关)。
- `go build ./internal/... && go vet ./internal/...`:clean(未改 Go)。

## 下一步
- 运行时验证:起桌面 app,在支持 effort 的 model(GLM-5.2 / Claude / GPT-5 等)上切 effort,
  确认 agent 实际生效(thought_level 改变)。当前改动在 opencode id="effort" 下行为等价,
  主要价值是协议正确性与未来 harness 适配的稳健性。
