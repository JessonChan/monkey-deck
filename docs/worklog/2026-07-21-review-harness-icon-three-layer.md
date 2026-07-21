# 2026-07-21 Review:#42 harness 官方图标三层集成端到端验收

## 起因

任务 #21287(Reviewer):对 PR #42 三层集成(harness 官方图标端到端)做验收审查。
父卡 MON-74 / 上层 #42;三张子卡:#21278 资源层、#21279 模型层、#21285 前端层。

## 审查范围

三个 commit(均已 merge 进当前分支):
- `3cc4c02 feat(harness): 内置官方图标资源(opencode/omp)+ 登记第三方许可`
- `7d3db0d feat(harness): Harness 加 Icon 字段 + Supported 默认 + binding 透出`
- `ac15ed7 feat(frontend): HarnessIcon 组件 + 侧栏/新建会话接入 harness 官方图标`

## 审查方法(防「编译绿但 bug 还在」)

针对 Reviewer 角色「签名改了但函数体行为没变」的常见失败模式,逐层验证字段 / prop
真实消费(不是类型补丁):

1. **模型层真实使用**:`Harness.Icon` 在 `Supported` 两条均填非空值;JSON tag `icon` 经
   wails3 binding 透出(重新生成确认 `models.js` 含 `this["icon"]` + JSDoc);
   `Discover` 在 `discover.go:158,165` 经 `byID[h.ID] = h` 整体复制 Supported,Icon
   自动带入运行时(无需改 Discover 代码),与 worklog 主张一致。
2. **前端层真实使用**:`HarnessIcon.tsx` 的 `harnessId` 进了 `src={`/harness-icons/${harnessId}.svg`}`,
   不是空 stub;Sidebar 在 `session-label` 后真的插了 `<HarnessIcon ... tooltip={...} />`
   且 tooltip 用上新增的 `harnesses` prop(经 `harnessNameById` 查表);NewSessionModal
   在 radio / name 间真的插了 `<HarnessIcon harnessId={h.id} ... />`;App.tsx 真的传了
   `harnesses={harnesses}`。全链路通电。
3. **资源层真实对齐**:`assets/harness-icons/{omp,opencode}.svg` 与
   `frontend/public/harness-icons/{omp,opencode}.svg` 逐字节相同(单一事实源 + 镜像);
   Vite build 产物 `dist/harness-icons/` 与 public 同源;binding 含 icon 字段;THIRD_PARTY_LICENSES
   §2.2/§2.3 MIT 登记 + 文件内 XML 版权头齐全(§0.4)。

## 验证(本机实跑)

- `go test ./internal/harness/... -v` —— 全过,含新增 `TestSupportedIcons` /
  `TestIconByKnownHarnesses`(后者锚定具体值,改路径会显式失败)。
- `go test -short ./...`(临时占位 frontend/dist)—— 全包通过,无回归。
- `go build ./...` + `go vet ./...` —— 通过(仅 macOS SDK ld warning,与改动无关)。
- `wails3 generate bindings` —— 成功,`Harness` model 含 `icon` 字段。
- `cd frontend && bun run build` —— 501 modules transformed,无 TS 错误;
  `dist/harness-icons/{omp,opencode}.svg` 与 public 镜像逐字节相同。
- 复核 `git status`:未夹带 references/、AGENTS.md、bindings、node_modules、dist。

## 结论

**通过(PASS)**。三层端到端真实连通,字段 / prop 均被消费,非类型补丁;测试断言真实
行为(锚定值 + 路径契约 + 文件名 = ID 不变量);§0.4 / §4.4 / §4.5 均合规。

## 非阻断性观察(供后续参考,不影响本 PR 通过)

1. `internal/harness/discover.go:146` doc 仍写「静态元数据(ID/Name/Command)」,
   与 `harness.go` 顶部「ID/Name/Command/Icon 四段」轻微漂移 —— 文档一致性问题,
   行为无误(Discover 整 struct 复制,Icon 已带入)。
2. 主题适配已知限制:`opencode.svg` 自带 `#131010` 深底,亮 / 暗主题均可;`omp.svg`
   透明底 + 近白填色(`#fafafa`),亮色主题下可能对比不足。worklog 已显式推迟
   (light 变体仍在 references),非本 PR 缺陷。
3. `harnessNameById` 在 Sidebar 函数组件内每次 render 重建 —— 与本文件既有 helper
   风格一致,性能影响可忽略(非 hot path)。

## 改了哪些文件

- 本审查记录:`docs/worklog/2026-07-21-review-harness-icon-three-layer.md`(本文件)。

## 验证

见上「验证」段;Reviewer 不改被审代码,仅产审查记录。

## 下一步

交回编排层判定 PR #42 合入;上述观察项可在后续卡处理或长期搁置。
