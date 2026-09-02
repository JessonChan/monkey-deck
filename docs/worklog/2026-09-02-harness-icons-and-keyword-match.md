# 2026-09-02 harness 品牌图标内置 + 启动命令关键词自动选

## 起因 / 为什么

- README 列了大量已知 ACP agent(共 52:2 内置 omp/opencode + 50 非内置)。此前只内置了
  omp/opencode 两枚图标,其余 agent 在前端一律走 `Bot` 兜底,识别度差。
- 用户要求:① 把收集到的官方图标内置(omp/opencode 已存在、本次不动);② 写一个**关键词匹配
  逻辑**——用户输入启动命令时,命中已知 harness 就**自动选中**(预填名称 + 展示图标)。

## 改法

### 1. 图标内置(只动非内置的 46 枚,4 枚无品牌图标不落图)
- 来源:`/tmp/harness-icon/`(上一轮从各 agent 官网 / 仓库收集的官方 logo)。
- 落地两份(单一事实源 `assets/harness-icons/` + Vite 运行时镜像 `frontend/public/harness-icons/`,
  见 `assets/harness-icons/README.md` 维护节):各 46 枚,文件名 = `<harness-id>.<ext>`(svg/png 随源格式)。
- `omp.svg` / `opencode.svg` 已存在,**原样保留不动**。
- 4 枚无官方图标(construct / minion-code / stdio-bus / vt-code)不落图,前端走 `Bot` 兜底。
- `assets/harness-icons/README.md` 新增「已知 agent 图标」表(46 行 + 来源 URL)。

### 2. 关键词匹配(后端 helper + 前端自动选)
- 新增 `internal/harness/known.go`:
  - `KnownHarness{ID,Name,Keywords}` + `KnownCatalog`(50 个非内置 README agent,**与
    `Supported`{omp,opencode} 严格分离**——只读数目录,不进 SQLite、不 spawn、不绑默认 harness 契约)。
  - `MatchKnownHarness(command) *KnownHarness`:命令转小写;对每个已知项,任一 keyword 命中即候选,
    取 **keyword 最长者**(更具体优先,如 `github-copilot` 优先于 `pi`);**短 keyword(<4 字符)须整词
    命中命令 token**,避免 `pi`⊂`shipping` 误中(§5.3 找不变量,不堆 if)。
  - keyword 由 id / 主命令别名 + dash 分词派生,剔除通用词(agent/ai/cli/code/dev/build)。
  - `internal/harness/known_test.go`:alias 精确 / npx 命令子串 / 整词短关键词 / 更长优先 / 排除内置 等用例。
- `internal/chat/chat.go` 新增 `ChatService.MatchKnownHarness(command) *harness.KnownHarness`
  (Wails binding;返回 nil = 无命中)。`make bindings` 重新生成 TS 类型(`frontend/bindings/` 已 gitignore)。
- 前端 `AddHarnessModal.tsx`:命令输入实时调 `MatchKnownHarness` → 命中即据返回 `id` 用 `HarnessIcon`
  展示图标、并**自动预填 Name**(用户手动改过 Name 则不覆盖,§4.4 不替用户做主);新增 i18n
  `settings.harness.addMatched`(en/zh)。

## 改了哪些文件
- 新增:`assets/harness-icons/*`(46 枚)、`frontend/public/harness-icons/*`(46 枚)、
  `internal/harness/known.go`、`internal/harness/known_test.go`、`docs/worklog/2026-09-02-harness-icons-and-keyword-match.md`
- 修改:`assets/harness-icons/README.md`、`internal/chat/chat.go`、`frontend/src/components/AddHarnessModal.tsx`、
  `frontend/src/i18n/locales/{en,zh}.json`

## 验证
- `go test ./internal/harness/... ./internal/chat/...` 全过(含 known_test 新用例)。
- `go build ./...`、`go vet ./internal/harness/... ./internal/chat/...` 通过。
- `cd frontend && bun run build`(tsc + vite)通过,新增 binding 方法 `MatchKnownHarness` 类型一致。
- 图标双目录各 48 枚(46 + omp/opencode),与 `HarnessIcon` 的 `/harness-icons/<id>.<ext>` 取图约定对齐。

## 下一步 / OPEN
- **许可证署名(§0.4)待补**:46 枚图标来自各 agent 官网 / 仓库(非 `references/` 目录),
  须在 `THIRD_PARTY_LICENSES.md` §2 逐枚登记来源 + 协议(omp/opencode 两条已登记,可作模板)。
  这是独立合规步骤,本次未做,需逐源确认协议后补登。
- 匹配目前只覆盖「启动命令 → 已知 agent 目录」。后续若要在 New Session 选择器也按项目名过滤,
  可复用同一 `MatchKnownHarness`,本次未接(用户只要求 Add Harness 弹窗自动选)。
