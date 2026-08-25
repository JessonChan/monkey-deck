# 2026-08-26 #132 FilePanel 搜索:搜索 icon + debounce 200ms SessionFuzzyFind(50) + 平铺列表 + ↑↓Enter/Esc 回树

## 起因
#132:文件面板只能逐层展开找文件,缺一个 quick-open 式搜索。后端 `SessionFuzzyFind`
(2026-07-26 落地,Composer @ mention 已用)一直在等文件面板接入(worklog 当时「下步」
明确留了这条)。本任务补前端:搜索 icon、防抖、平铺结果、键盘导航,且**零缓存改动**
(不动 `filePanelCache`)。

## 设计
- **入口**:工具栏新增 Search icon 按钮(react-tooltip `md-tip`,§4.5 硬约束——新元素
  不用原生 title)。点击 toggle:开 = 渲染输入行 + 聚焦;关 = 退出搜索回树。
- **防抖 200ms → `SessionFuzzyFind(sessionId, "", query, 50)`**:整棵 cwd 树(scope="")
  模糊匹配,limit 50。清理用 clearTimeout + cancelled 标志,另加**单调 seq ref** 兜底
  「在途旧响应晚到覆盖新结果」(clearTimeout 只能取消未发出的 timer,取消不了已上线的
  请求;seq 不匹配即丢弃)——mount 测试专门复现该竞态。
- **平铺列表**:查询非空时 tree-body 整体切到结果列表(复用 `.tree-row` 行样式):
  文件/目录 icon + name + 右对齐暗色 mono 完整相对路径(跨目录同名命中可区分,§4.4)。
  查询为空时树照常显示(输入行在、树在下)。搜索中输入行内转 spinner;零命中显
  「无匹配文件」。
- **键盘**:输入框内 ↑/↓ 移动 active 行(clamp 不循环,hover 行同步 active)、Enter
  选中:文件 → `onOpenFile` 打开编辑器 tab;目录 → **回树揭示**(展开 + 加载全部祖先
  目录、选中该行),两者都退出搜索回树;Esc 退出搜索回树。active 行
  `scrollIntoView({block:"nearest"})` 保持可见。
- **零缓存改动**:`filePanelCache.ts` 一行未动。搜索状态(searchOpen/query/results/
  activeIdx/searching)全是组件内瞬态;树的 expanded/children/selected 在搜索期间不被
  触碰,Esc/Enter 回树时树与搜索前一模一样(mount 测试钉死该不变量)。
- **实现形态偏离说明(重要)**:搜索输入框用**非受控 input + 原生 addEventListener
  ("input"/"keydown")**,而非惯用的受控 + onChange/onKeyDown。原因:happy-dom(本仓
  mount 测试环境)+ React 19 下,带 React 文本事件 props(value/onChange,甚至 onInput)
  的 input 上,手动 dispatch 的 input/keydown 事件**全部无法触发 React 合成处理**
  (Composer.mount.test 注释早有记载:「受控 input/textarea 的 onChange 在 dispatchEvent
  派发的 input 事件下不触发」;本次实证更进一步:onChange 存在时连 onKeyDown 都死,
  原生 listener 却能收到)。走原生 listener 在真实 webview(WebKit/WebView2)行为完全
  一致且更贴近 DOM 真相,换来搜索全流程可在 mount 测试里端到端驱动。keydown 闭包经
  `pickResultRef` 拿最新 pick 动作,避免每 render 重订阅。

## 改了哪些文件
- `frontend/src/components/FilePanel.tsx`:搜索状态机 + 防抖 effect + seq 守卫 + 原生
  listener effect + revealInTree + 工具栏按钮 + 输入行 + 平铺结果列表。
- `frontend/src/index.css`:`.file-search-row/-input/-path` + `.file-search-item` 的
  tree-name 覆写(全局规则,与既有 file-panel 样式同层;≤768px 无需特判,行尺寸与
  既有 tree-row 一致)。
- `frontend/src/i18n/locales/{zh,en}.json`:`filePanel.search*` 4 键(zh/en 对齐,
  locales.test 守恒)。
- `frontend/src/components/FilePanel.search.mount.test.tsx`(新):6 用例——防抖合并
  单次调用(scope=""/limit 50/全路径平铺)、↑↓+Enter 开文件回树、Esc 回树且树状态
  原样(零缓存不变量)、Enter 目录命中回树揭示(祖先展开+选中)、空 query 不打后端 +
  零命中提示、在途旧响应不覆盖新结果(seq 竞态)。

## 验证
- `bun run build`(tsc + vite production)过。
- `bun test`(全量,--isolate 同):**275 pass / 5 fail——5 个 NewSessionModal 失败为
  本地既有**(git stash 后干净树同样 0 pass / 5 fail,与 #128 worklog 记载一致,本机
  环境问题;本改动净增 6 个通过用例)。新文件 6/6 绿;SidePanel.mount(5 用例)、
  locales.test 回归绿。
- `go build ./...`、`go vet ./...` 过(无 Go 改动,过门禁)。
- **三端矩阵(§4.7/§5.6)**:
  - 桌面 GUI:组件级行为由 mount 测试覆盖(binding 调用形态与 @ mention 同一
    SessionFuzzyFind 通道);未起 wails3 dev 手工冒烟。
  - 远程浏览器 / PWA:同一份 React 代码,无 `isRemoteClient()` 分支、无 WS 事件面
    改动、无 ≤768px 断点触碰;tooltip 在 coarse-pointer 端由 App 层统一隐藏(既有
    行为)。未做 server 模式浏览器 E2E,留待用户真机/日常使用冒烟。
- bindings 为 gitignore 中间产物,本任务零 Go 改动,无需重生成(现有
  SessionFuzzyFind 签名未变)。

## 下步 / OPEN
- 真机 / 远程端冒烟一次搜索交互(输入、↑↓、Enter、Esc)。
- 若后续要「搜索结果带 git 状态徽标 / 右键菜单」,在结果行复用 statusByPath 与
  ctx-menu 通道即可(当前按 KISS 未做)。
