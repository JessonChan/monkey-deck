# 2026-09-05 harness 详情卡(#195)前端 review 记录(fe-review #29001)

## 背景

Task #29002:对 #195「宫格正下方 harness 详情卡」(实现提交 `5e981d9`,父 `78333f1`,
6 文件 +424/−1)做反相追踪 review:不信 commit 叙事,从代码出发逐项核实 9 条清单。

## 结论:APPROVE

9 项全部核实通过,无 NEEDS_CHANGES 项。

## 逐项核实(反相追踪,均以代码/运行结果为证)

1. **详情卡位置与占位**:详情卡是 `ns-field` 内 `.ns-harness-list` 的下一个兄弟
   `div[data-testid=ns-harness-detail]`(NewSessionModal.tsx:406),纯文档流、
   无 absolute/fixed——结构上不可能遮列表;宫格自带 `max-height:256px +
   overflow-y:-auto`(index.css 既有),兄弟节点追加不挤压宫格。≤768 下
   `.new-session-card` 走 `max-height+overflow-y:auto`,详情卡在卡内滚动。
   未选中 → `ns-detail-placeholder`(`--text-3` 淡灰)+ `newSession.detailPlaceholder`
   (zh/en 各有);`selected` 由 `harness` state 每渲染派生,切换即刷新(mount 测试 2
   实证 omp→goose 全字段刷新)。
2. **命令行全文 + 复制**:`ns-detail-cmd` `flex:1 + word-break:break-all`(换行不截断),
   `ns-detail-copy` 按钮 → `copyTextQuiet(h.command)`(lib/clipboard.ts:89,fire-
   and-forget 既有语义)。
3. **Path 行**:`{path && …}` 空/undefined 整行不渲染;`.ns-detail-path` ellipsis
   截断,`data-tooltip-content`=全文(`md-tip` 全局挂载,App.tsx:2856),点击
   `copyTextQuiet(path)`。测试断言 textContent、tooltip attr、copy 实参三处锚定值。
4. **版本行**:`installedVersion || "—"`;`latestVersion` 非空才渲染 ` → latest`;
   `upgradeAvailable` → amber `↗` + `newSession.upgradeHint` tooltip。测试锚定
   `1.2.3`/`1.4.0`/tooltip 值,并断言 goose 侧三者消失。
5. **安装态**:未装 → `newSession.notInstalled` + `ns-detail-muted`(`--text-3` 灰显),
   已装 → 新键 `detailInstalled`。测试断言文本 + class。
6. **自定义 chip**:`userDefined` 才渲染 `ns-detail-chip`,文案 zh「自定义」/en「Custom」。
7. **类型补丁反模式核查**:组件消费字段逐个反查——`id/name/command/path/installed/
   installedVersion/latestVersion/upgradeAvailable/userDefined` 全部在 `renderDetail`
   或选择逻辑被真实读取,无「只存在于类型签名」的死字段;与 Go struct json tag
   (internal/harness/harness.go:23-41)及本机重新生成的 TS models.ts 逐字段对上。
   **后端 Go / 绑定生成物零改动**(diff 仅前端 4 改 + 1 新测试 + worklog;bindings
   gitignored 不可能入库)。附带观察(非本提交引入,不阻塞):struct 的
   `upgradeError` 前端尚无消费端,属存量缺口,留给 #190 后续。
8. **i18n 与测试**:zh/en 各 +8 键,key 集合对称,`i18n/locales.test.ts` 平价测试
   守门(zOnly/eOnly 为空);`notInstalled` 复用既有键未改名。新 mount 测试 3 条全部
   **锚定值断言**(精确文本/attr/copy 实参),非字段存在性。本机实证:
   `bun test --isolate` = **567 pass / 0 fail**(79 文件,与实现 worklog 数字一致);
   既有 `NewSessionModal.mount.test.tsx` 不在 diff,零触碰;`bunx tsc` 0 错。
9. **红线(1 行删除查明)**:全部 diff 仅 3 hunk(imports / renderDetail 插入 /
   详情卡插入),唯一删除行 = `import { Check }` → `import { Check, Copy }`——
   模块 import 行改写,**不是宫格卡片本体**,`Check` 保留(选中角标仍在用)。
   宫格 #188 JSX 逐字节未动;worktree 二选一链(mode/existingDir/baseRef 状态机)
   所在 hunk 之外,零波及。

## Review 环境备注(复现 567 pass 的前提)

本 worktree 缺 gitignored 的 `frontend/bindings/` 与 `node_modules/`:裸跑
`bun test` 会得到 13 个 `Cannot find module .../bindings/...` 假失败。先
`bun install --frozen-lockfile` + `wails3 task bindings`(§0.5 钉版任务)再跑,
即得 567/0。后续 agent 在新 worktree 验证前端时按此顺序。

## 三端(§4.7)

后端/binding 零改动 → 无 server 模式统一验证项;前端为共享组件内纯追加
DOM/CSS,无 `isRemoteClient()` 分支、无断点特判;390px 依赖 `min-width:0` +
ellipsis/word-break,无固定宽,结构上无横向溢出路径。GUI/浏览器/PWA 目测
(390px 换行与截断手感)按实现 worklog 留人,本 review 不重复。

## 下一步

- 无阻塞项。实现提交可保持,人的三端口测与「未安装(安装指引)」文案取舍
  (实现 worklog 已标注的单点)由人定夺。
