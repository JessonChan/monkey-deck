# 2026-08-28 · session 标签 MVP:0021 tags 列 + 哈希配色 + ctx 赋值 + 单标签过滤(#150)

## 起因

Task #27983(父 issue #27982 六点拍板定版):给 session 加用户标签 MVP——按目录组织对话之外的第二根组织轴。范围收敛:单标签过滤、零颜色管理 UI、无管理面板/批量赋标/多选布尔/跨项目聚合/M2M(完整版边界不在本卡)。

## 方案与决策

### 存储层(0021)

- `internal/store/migrations/0021_session_tags.sql`:`sessions` 加 `tags TEXT NOT NULL DEFAULT '[]'`(JSON 字符串数组)。标签纯组织层元数据,**不动 `updated_at`**(与 pinned 0008 / custom_title 0016 同理:不是内容活动,不洗侧栏时间显示与二级排序)。
- `Session.Tags []string`(json `tags`);`sessionColumns` 尾部追加 `tags`,`scanSession` 扫进临时 string 后经 `decodeTags` 解析——**损坏/空值降级为空 slice 而非让整条 session 读取失败**(坏行不能白屏侧栏)。
- **写入层归一化 `NormalizeTags`**(单一事实来源,store 层):trim 每项 → 丢空串 → **大小写敏感**精确去重(幂等)→ 上限 `MaxSessionTags=5` 截断(保首次出现序)。`UpdateSessionTags` 落库前归一化,空集 = 清空全部。

### 绑定层(回传权威集合)

- `ChatService.UpdateSessionTags(sessionID, tags) ([]string, error)`:**返回归一化后实际落库的集合**,前端乐观更新直接镜像 DB,不漂移(例:第 6 个标签被截断时,本地不会短暂显示 6 枚 chip)。store 层保留自己的归一化作为其它调用方的防线。

### 配色(零颜色管理 UI)

- `frontend/src/lib/tagColor.ts`:8 色 Gmail label 浅色 chip 家族——tomato `#f28b82` / tangerine `#fcad70` / banana `#fbbc04` / sage `#ccff90` / mint `#a1e4cb` / blueberry `#aecbfa` / grape `#d7aefb` / flamingo `#fdcfe8`。全部浅底深字(chip 文字固定 `#2d2e30`),深色侧栏上同样可读。
- **哈希公式:`idx = FNV-1a 32(name) mod 8`**(UTF-16 code units,`Math.imul` 防溢出)。无随机、无存储——同名跨 session/项目/重启/窗口恒同色。
- `collectTags`:项目内 session 标签并集(首次出现序),喂过滤 chip 行。

### Sidebar 三件套

1. **行内 mini-chip**:session 标题行 meta 区(harness 图标后、pin 同位)彩色小 chip;12px 纪律 CSS——固定 `height:14px / line-height:12px / font-size:10px / flex-shrink:0 / overflow:hidden`(长名省略号,永不换行/撑行)。tooltip 即标签名。
2. **ctx「标签 ›」二级菜单**(hover 展开,纯 CSS `.ctx-has-sub:hover`):已有标签打勾(Check)行,**点击移除**;底部输入框 **Enter 追加**(空值忽略,追加后清空便于连续录入);空态「暂无标签」。**数据一律读 `liveSession(ctx.session.id)`**——ctx.session 是开菜单时刻的快照,标签增删经乐观更新后快照会过期,现查保证打勾状态实时反映,菜单不关可连续增删。
3. **per-project 单选过滤 chip 行**:展开项目的搜索框下方渲染该项目标签并集;单选激活(再点取消,点另一枚换键),`tagFilter: Record<projectId, tag>` 状态 per-project 互不干扰(照 searchProj 模式)。**与搜索 AND**:标签先收窄集合,搜索(标题 ∪ 内容命中)再在结果上过滤;过滤态绕过分页(与搜索行为一致),「加载更多」与非空态提示随之门控。

### 顺带的既有面修复:session 搜索输入改原生 listener

写 AND 叠加测试时实证(happy-dom + React 19):**合成 `onChange` 从手动 dispatch 的 input 事件不可达**(最小 controlled input 复现;keydown 委托还需先 focus 才可达)。FilePanel 已有同坑先例——其搜索输入用**非受控 + 原生 `input` listener**(注释明言「happy-dom 和真实 webview 都可达」)。Sidebar session 搜索输入照此改为非受控 + 原生 listener(`useEffect` 绑定,随 searchProj 重挂重绑);清空按钮同步清 DOM value。生产语义不变(每键击 setQuery 一次),测试/真 webview 双通。

### i18n

`sidebar.tags / tagsEmpty / tagNewPlaceholder / tagRemoveTip / tagFilterActive / tagFilterIdle`(zh/en 六对同步),locales.test leaf-key 集合一致回归通过。

## 改了哪些文件

|文件|改动|
|---|---|
|`internal/store/migrations/0021_session_tags.sql`|新增:`tags TEXT NOT NULL DEFAULT '[]'`|
|`internal/store/store.go`|`Session.Tags []string`|
|`internal/store/sessions.go`|`sessionColumns`/`scanSession` 接 tags;`MaxSessionTags=5` + `NormalizeTags` + `decodeTags` + `UpdateSessionTags`|
|`internal/store/tags_test.go`|新增:NormalizeTags 六例(含幂等)、UpdateSessionTags 往返/归一化落库/清空/不动 updated_at、损坏行降级、0021 列形(status/NOT NULL/default)| 
|`internal/chat/chat.go`|`UpdateSessionTags` binding(归一化后落库,回传权威集合)|
|`frontend/src/lib/tagColor.ts`|新增:FNV-1a 哈希 + 8 色 Gmail 调色板 + `collectTags`|
|`frontend/src/components/Sidebar.tsx`|props `onSetSessionTags`;`tagFilter` 状态 + `toggleTagFilter` + `liveSession`;`projectList` AND 逻辑;过滤 chip 行;行内 mini-chip;ctx「标签 ›」二级菜单;搜索输入改非受控 + 原生 listener;分页/空态门控|
|`frontend/src/App.tsx`|`setSessionTags` callback(用后端回传的归一化集合做乐观替换);传 `onSetSessionTags`|
|`frontend/src/index.css`|`.session-tag-chip`(12px 纪律)/`.session-tags-row`/`.session-tag-filter`(active 环)/ctx 子菜单一族(`.ctx-has-sub`/`.ctx-submenu`/`.ctx-tag-input` 等)|
|`frontend/src/i18n/locales/zh.json` / `en.json`|sidebar 六对标签 key|
|`frontend/src/components/Sidebar.tags.mount.test.tsx`|新增:六场景 mount 测试(见验证)|

## 验证

**硬测试(任务书五场景 + store 三防线全绿)**:

- `go test ./internal/store/ -run 'TestNormalizeTags|TestUpdateSessionTags|TestSessionTagsCorruptRow|TestMigration0021'`:NormalizeTags trim 空串/去重幂等/上限截断/首现序;写→读 JSON 往返一致(ListSessions 与 GetSession 同路);脏输入落库干净;空集清空;**updated_at 不动**;`not json`/`{"a":1}`/`[1,2]`/`null` 损坏行 + 前置列缺省旧行全部降级空 slice 不炸读取;pragma 列形 TEXT/NOT NULL/'[]' 钉死。
- `bun test src/components/Sidebar.tags.mount.test.tsx`(6 场景):①ctx 赋值渲染——带标签行出彩色 chip(背景 = tagColor 哈希取色、tooltip 即名)、无标签行零 chip;②ctx 二级菜单 Enter 追加进**活**集合 `["api","db"]` 且输入框清空;③打勾行点击移除恰好那枚(`["db"]`);④单选过滤——激活收窄/再点取消全量回/换 chip 换键;⑤搜索 AND——先 alpha(s1+s3)再叠 api chip → 只剩 s1(交集);⑥行高纪律——带 5 标签行与无标签行 `offsetHeight` 相等 + `.session-tag-chip` CSS 契约钉死(`flex-shrink:0`/`height:14px`/`line-height:12px`/`overflow:hidden`;happy-dom 无布局引擎,几何相等在测试环境是弱断言,CSS 钉死 + 桌面目检兜底,已在测试注释里如实标注)。
- **套件**:`bun run test`(仓库门 = `bun test --isolate`)403 pass / 0 fail,含 locales.test zh/en 同步。⚠ 直接 `bun test`(无 --isolate)会有跨文件 global realm 串扰(clipboard/ErrorCard 假失败),仓库门命令即隔离模式,与本坑无关。
- **Go 门**:`go build ./...` + `go vet ./...` 干净;`go test ./...` 全包 ok(chat 19.8s / store 4.5s;ld 的 macOS SDK 版本 warning 为环境噪声)。
- **前端构建**:`bun run build:dev`(tsc + vite)绿,产出 dist 供根包 go:embed。bindings 经 `go run …cmd/wails3@v3.0.0-alpha2.106 generate bindings` 重生成(**CLI 需与 go.mod 同版**:机器上的 wails3 是 beta.3,会产出不兼容的 .js 形态,必须用 go.mod 钉住的 alpha2.106 跑,见 OPEN)。
- **三端矩阵(§4.7)**:本改动为共享 Sidebar 上的纯增量 UI(无原生对话框/clipboard/WS 通道差异,CSS 全部走既有变量 + 固定浅色),mount 测试在组件层验证行为。**桌面 GUI / 远程浏览器 / PWA 的目检与真机手感未在本卡执行**,与仓库 review 流(前端面终审卡)衔接补做;后端/binding 面已按 §5.6 统一验一次。

## OPEN / 下一步

- **wails3 CLI 版本漂移**:本机 `wails3` 是 v3.0.0-beta.3,`go.mod` 钉 v3.0.0-alpha2.106——beta CLI 生成的 bindings 形态(.js + 不同 ID)与 alpha 生成的不一致,直接跑会悄悄换形态。本次用 `go run github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-alpha2.106 generate bindings` 保证三者同版(§0.5)。后续要么统一升 CLI + module(一起动),要么在 Taskfile/README 里写明用 go run 钉版生成。
- ctx「标签 ›」子菜单纯 CSS hover 展开,右缘贴边时子菜单可能溢出视口(主菜单已有 clamp,子菜单没有);完整版(管理面板/多选布尔)若落地时一并做定位翻转。
- 标签过滤与 keyboard-nav(↑/↓/Enter)共存但不过滤 kbdList 语义之外的可见性(projectList 已共用,行为一致);完整版如做多选布尔需重新审视。
- 三端目检(桌面 GUI 深浅主题、远程浏览器、PWA ≤768px 抽屉内 chip 触控)待 review 卡补做。
