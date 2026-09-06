# 2026-09-05 新建对话弹窗 harness 详情卡(#195)

## 背景 / 起因

#195:#188 把 harness 选择器改成图标宫格后,命令、路径、版本等
「这个 harness 到底是什么/装没装/新不新」的信息全收进了卡片 tooltip,
选中一个 harness 后没有任何常驻的可读详情面。本轮在宫格正下方追加一张
固定详情卡:未选中时淡灰占位,选中即以行式人话布局(每字段带标签,
不裸 JSON,§4.4)展示命令 / 可执行文件路径 / 已装与最新版本 / 安装态,
并给用户 harness 打「自定义」chip、给可升级项加 ↗ 提示。

## 设计(实现者裁量点与理由)

- **纯文档流追加,不遮不挤**:详情卡是 `ns-field` 里宫格容器的下一个
  兄弟节点,普通流布局,结构上不可能遮挡或挤压宫格(任务红线)。
- **复制统一走 `copyTextQuiet`**(lib/clipboard):详情卡是「即将消隐的
  弹窗内的一次性动作」,无成功/失败反馈面,与 CopyIconButton 的
  copied/check 反馈形态不同——按任务给定用 fire-and-forget 变体,
  失败仅 console 可观察(lib/clipboard 既有语义)。
- **Path 行点击即复制**,不另设复制按钮:路径本身是唯一值,点击目标
  = 值本身,行内再放一个按钮属重复;省一行 UI(§5.3 Less is More)。
  截断走 CSS ellipsis,全文在 `md-tip` tooltip(§4.5),点击复制
  (copyTextQuiet)。
- **命令行允许换行(word-break),路径行单行截断**:命令全文要可读可
  核对(任务要求全文),长路径则截断 + tooltip 已可满足。
- **版本行 `已装 → 最新` 形态**:latestVersion 为空(未查/无源/用户
  harness)时只显示已装版本,不渲染「→ —」残腿;upgradeAvailable 时
  追加 ↗(amber 色 + upgradeHint tooltip)。upgradeAvailable=true 蕴含
  latestVersion 非空(后端 discover 派生逻辑),故 ↗ 出现时箭头必在。
- **安装态未装值复用既有 `newSession.notInstalled`**(与本命名空间内
  宫格角标同一字符串),已装值新增 `newSession.detailInstalled`;
  未装值加 `ns-detail-muted` 灰显。任务文案「未安装(安装指引后补)」
  按「安装指引后续再补」理解——用户可见文案就是「未安装」,括号内容
  是任务备注,不作为 UI 文案(若理解有误,改 locale 一个值即可)。
- **详情卡头部 = harness 名 + 自定义 chip**:chip 需要上下文才有意义,
  名字给出「这是谁的详情」;HarnessIcon 组件零改动也未引入。
- **类型声明零入库改动**:`frontend/bindings/` 是 gitignored 的生成物,
  `wails3 task bindings` 按 go.mod 钉版本重新生成后 `Harness` 已含
  path/installedVersion/latestVersion/upgradeAvailable/userDefined/source
  (后端 `internal/harness/harness.go` json tag 早已序列化,任务也确认
  「后端 json 已序列化,仅类型声明」),故本轮无类型文件可提交。
- **新测试独立成文件** `NewSessionModal.harness-detail.mount.test.tsx`,
  不触碰既有 `NewSessionModal.mount.test.tsx`——既有测试零回归由构造
  保证;clipboard 用 `mock.module("../lib/clipboard")` 捕获
  copyTextQuiet 调用,不碰真实剪贴板通道。

## 改动

- `frontend/src/components/NewSessionModal.tsx`:
  - 新增 `selected`(当前选中 Harness 对象)与 `renderDetail(h)`;
  - 宫格容器(`ns-harness-list`)正下方追加详情卡
    `data-testid="ns-harness-detail"`:未选中 →
    `ns-detail-placeholder`(newSession.detailPlaceholder);选中 →
    头部(名 + userDefined chip)+ 命令行(全文 + copy 按钮
    `ns-detail-copy`)+ Path 行(path 非空才渲染,点击复制 + tooltip
    全文)+ 版本行(`ns-detail-version`,installedVersion →
    latestVersion,upgradeAvailable 加 `ns-detail-upgrade` ↗ +
    upgradeHint tooltip)+ 安装态行(`ns-detail-install`,未装灰显);
  - import 增 lucide `Copy` 与 `copyTextQuiet`。
  - **宫格卡片本体(#188 JSX)零改动**(diff 仅追加)。
- `frontend/src/index.css`:新增 `.ns-harness-detail` 及
  `.ns-detail-*` 样式块(置于 #188 宫格样式与 worktree 二选一样式
  之间);`min-width:0` + flex 基线对齐,label 列 52px,390px 不依赖
  任何断点特判。
- `frontend/src/i18n/locales/{zh,en}.json`:`newSession` 新增 8 键——
  detailPlaceholder(选择 harness 查看详情 / Select a harness to see
  details)、detailCommand(命令/Command)、detailPath(路径/Path)、
  detailVersion(版本/Version)、detailInstall(安装/Install)、
  detailInstalled(已安装/Installed)、upgradeHint(有可用更新/Update
  available)、userDefinedChip(自定义/Custom)。两文件键集合由
  `i18n/locales.test.ts` 平价测试守门。
- `frontend/src/components/NewSessionModal.harness-detail.mount.test.tsx`
  (新增):三测——①未选中占位 + 无详情行;②选中 omp → 各行字段断言
  (名/命令/path 文本与 tooltip/双版本/↗ tooltip/已装),切 goose →
  全字段刷新(path 行消失、↗ 消失、未装灰显 + 自定义 chip);
  ③copy 按钮与 path 点击各触发一次 copyTextQuiet 且参数正确。

## 红线核对

- 后端 / bindings 生成物零改动(`git status` 仅前端 4 改 + 1 新测试);
- #188 宫格卡片本体零改动(diff 纯追加,含 tooltip/角标/排序全部原样);
- HarnessIcon 零改动;#190 更新提醒面板及设置页零波及(未触碰任何
  HarnessSettings / HarnessUpdateAwareness 相关文件);
- 借用参考库代码:无。

## 验证

- `bun test --isolate`:**567 pass / 0 fail**(79 文件,含新增 3 测,
  既有 NewSessionModal 全部测试零回归)。
- `bunx tsc`:0 错;`bun run build`(tsc && vite build):过
  (chunk >500kB 警告为存量)。
- 三端:后端/binding 零改动,无需 server 模式统一验证;改动为弹窗内
  纯追加 DOM/CSS,无 `isRemoteClient()` 守卫分支、无断点特判、无
  WS/事件通道涉入,GUI / 远程浏览器 / PWA 共用同一组件——
  **390px 窄屏与三端口感目测留人**(任务显式留给人):390px 下 label
  52px + 值列 flex 收缩,命令换行、路径 ellipsis,不应横向溢出。

## 下一步

- 人在桌面 GUI / 远程浏览器 / PWA(≤768)目测详情卡观感,重点 390px
  换行与截断;若「未安装(安装指引后补)」的括号内容确要作为用户文案,
  改 `newSession.notInstalled` 或换专用键一处即可。
