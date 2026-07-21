# 2026-07-21 前端层:HarnessIcon 组件 + 侧栏 / 新建会话接入

## 起因

上层需求 #42 / 父卡 MON-74(#21277):不同 harness 在侧栏会话行 + 新建会话选择列表
显示**各自官方图标**(opencode 用 opencode 的、omp 用 omp 的)。

三层设计的前两张子卡已完成:
- 资源层(#21278 / MON-75):`assets/harness-icons/<id>.svg` 内置官方 SVG + 第三方许可登记。
- 模型层(#21279):`harness.Harness.Icon` 字段 + Supported 默认填好 + binding 透出前端。

本条是三层设计的**前端层**子卡(原 #21280 cancelled 后由本卡 #21285 复活接手):
做 HarnessIcon 组件按 `harness.icon` 取图、未知 / 空值走 lucide `Bot` 兜底,
并在侧栏会话行 + NewSessionModal 接入。

## 设计

### 资源接入:assets/harness-icons/ → frontend/public/harness-icons/(Vite public 镜像)

选项权衡(§5.3 KISS + §5.3 单一事实源):
- **方案 A:拷进 `frontend/public/harness-icons/`(选定)**
  - Vite 把 `public/` 整目录原样拷进 dist 根,运行时经 `/harness-icons/<id>.svg` 访问。
  - 优点:零运行时开销、零额外构建配置、跨平台稳定、与既有 `wails.png` / `Inter-Medium.ttf`
    同一机制(没有新模式)。
  - 代价:与 `assets/harness-icons/` 有等量副本,需手动同步。
- 方案 B:Vite `?url` import 跨越 frontend/ 目录拉 `../../../assets/harness-icons/*.svg`。
  默认 `server.fs.allow` 限制 workspace root(= frontend/,因 bun.lock 在此)→ 需放宽白名单;
  生产 Rollup 跨 root 解析不稳。增加构建复杂度,被否。
- 方案 C:加 Vite 插件在 build/dev 时从 `assets/harness-icons/` 拷贝。2 个 SVG 上加一层插件,
  收益不抵复杂度,被否。
- 方案 D:Go binding 读字节 → base64 注入。增加 binding surface 与序列化开销,被否。

**方案 A 落地**:`assets/harness-icons/<id>.svg` 是**唯一事实源**(版权头 / 维护规则都在那里),
`frontend/public/harness-icons/<id>.svg` 是等量副本(不动版权头,纯运行时镜像)。
同步约定写进 `assets/harness-icons/README.md`「维护」段:新增 / 替换 SVG 后必须同步拷贝,
否则前端取不到图、HarnessIcon 自动走 Bot 兜底(降级正确,不报错)。

### 组件 API:按 harness ID 直接归并取图(无映射表)

`HarnessIcon` props:
- `harnessId?: string` —— harness ID(如 "omp" / "opencode")。空 / 加载失败 → Bot。
- `size?: number`(默认 14)、`className?: string`、`tooltip?: string`(可选)。

按 ID 而非按 `icon` 路径取图的依据(§5.3 KISS + assets/harness-icons/README.md):
- 资源层 README 已写明「文件名 = harness.Harness.ID,前端按 harness ID 直接归并取图」,
  这是自顶向下的约定 → 直接照做,ID → URL 一对一,无中间映射。
- 调用方拿到的数据:`Session.harness` 是 ID,`Harness.id` 也是 ID,两边都对得上。
- 模型层 `Harness.Icon` 路径只在 harness 管理面板等需要展示路径文本时用;此处取图不必经过它。

### 兜底链:空 ID / 加载失败 / 未知 harness 全部走 lucide Bot

`useState(failed)` + `onError → setFailed(true)`:网络错、路径错、文件缺、SVG 损坏,
全部触发 `failed` → 重新渲染切到 `<Bot />`。空 `harnessId` 也直接 Bot。
**任何情况下都不会出现破图**(§4.4 不裸露技术格式的精神:不把 broken image 抛给用户)。

### tooltip(§4.5):Sidebar 给图标加 hover tooltip

§4.5 把「状态指示」列为必须有 tooltip 的类别,harness 品牌图属于此类(用户未必认得每个 logo)。
- Sidebar session 行:`tooltip={t("sidebar.harnessTip", { name: harnessNameById(s.harness) })}`,
  其中 `harnessNameById` 从 App 传入的 `harnesses` 列表按 ID 查显示名(「Oh My Pi」/「OpenCode」,
  比 ID 友好);列表缺该 harness(如已卸载)时回退到 ID 本身,不空。
- NewSessionModal 不加 tooltip:harness name 已在图标旁明文展示(`h.name`),再加 tooltip 冗余。

### 视觉细节

- **原图自带背景**:opencode mark 自带 `#131010` 深色底(512×512),omp 在深色背景上是浅色 Pi 符号。
  在小尺寸(12-16px)下用 `object-fit: contain` + `border-radius`(3-4px)适配,不裁切、不变形。
  主题(明 / 暗)适配留待后续:opencode light 变体 `mark-light.svg` 仍在 references,本卡不引入多变体
  (assets/harness-icons/README.md 已声明「主题适配是前端层职责,不在本目录引入多个变体」)。
- **Sidebar 透明度分层**:idle 0.6 / hover+active 0.9,弱化常驻状态、聚焦时回到前景层次,
  与既有的 session-dot / pin / terminal-mark 弱色策略一致。
- **位置**:Sidebar 放在 session-label 之后、pin 之前(label flex:1 把它推到右边状态簇旁);
  NewSessionModal 放在 radio 与 name 之间(选择项的「icon + 名字」配对,符合直觉)。

## 改了哪些文件

- `frontend/src/components/HarnessIcon.tsx` —— 新增。按 ID 取 `/harness-icons/<id>.svg`,
  失败 / 空 ID → Bot;支持 size / className / tooltip 透传。
- `frontend/public/harness-icons/omp.svg` —— 新增。`assets/harness-icons/omp.svg` 的等量运行时镜像。
- `frontend/public/harness-icons/opencode.svg` —— 新增。同上,opencode 版本。
- `frontend/src/components/Sidebar.tsx`:
  - 加 `import HarnessIcon`、`import type { Harness }`。
  - Props 加可选 `harnesses?: Harness[]`(供 tooltip ID → 显示名查表)。
  - 加 `harnessNameById(id)` 辅助函数(查表 + ID fallback)。
  - session-item-main 内 session-label 后插入 `<HarnessIcon harnessId={s.harness} ... tooltip={...} />`。
- `frontend/src/components/NewSessionModal.tsx`:
  - 加 `import HarnessIcon`。
  - `.ns-harness` 按钮内 radio 与 name 之间插入 `<HarnessIcon harnessId={h.id} size={16} />`。
- `frontend/src/App.tsx`:Sidebar 调用处补 `harnesses={harnesses}` prop。
- `frontend/src/index.css`:
  - 加 `.session-harness-icon`(flex-shrink:0 / border-radius:3px / object-fit:contain / opacity 分层)。
  - 加 `.ns-harness-icon`(flex-shrink:0 / border-radius:4px / object-fit:contain)。
- `frontend/src/i18n/locales/{en,zh}.json`:加 `sidebar.harnessTip = "Agent: {{name}}"`。
- `assets/harness-icons/README.md` 「维护」段新增「同步镜像到前端 public」条目(单一事实源 + 同步约定)。

## 验证

- `wails3 generate bindings` —— 重新生成(本地 gitignored),确认 `Harness` class 含 `icon` 字段(模型层已加)。
- `cd frontend && bun run build`(`tsc && vite build --mode production`)—— **通过**,
  501 modules transformed,无 TS / 编译错误。dist 产物含 `dist/harness-icons/{omp,opencode}.svg`
  (验证 Vite public 镜像生效)。
- `go build ./... && go vet ./...`(acceptance gate)—— 通过(无 Go 改动,仅 macOS SDK ld warning,
  与本卡无关)。
- 设计核对:assets/harness-icons/README.md 命名约定 `<id>.svg` ↔ HarnessIcon 取图 URL `/harness-icons/<id>.svg`
  ↔ Session.harness / Harness.id 全部对得上(§5.3 单一事实源)。
- `git status` 复核:未夹带 `references/`、`AGENTS.md`、构建产物、bindings 目录、node_modules、frontend/dist。

## 下一步

- 明暗主题适配:若暗色主题下 opencode 深底图标对比不足,考虑引入 `mark-light.svg` 变体
  (仍在 references/opencode/packages/identity/),或用 CSS filter 反色。本卡不引入多变体(避免过度设计)。
- HarnessSettings 面板(`frontend/src/components/HarnessSettings.tsx`)目前没用 HarnessIcon
  (它展示 harness-name / harness-id / 版本等信息,品牌图非必需)。若后续要统一所有 harness 出现处都带官方图,
  可在那里也接入。本卡范围只覆盖需求里点名的「侧栏 + 新建会话」。
- 跨平台渲染验证(§4.6):opencode 深底 + 圆角在 macOS WebKit / Win WebView2 / Linux WebKitGTK 下的
  渲染一致性,需在真机 / server 模式 + 浏览器下人工核对(本卡仅做实现,未做跨平台视觉巡检)。
