# 2026-07-21 模型层:Harness.Icon 字段 + Supported 默认 + binding 透出

## 起因

上层需求 #42 / 父卡 MON-74(#21277):不同 harness 在侧栏会话行 + 新建会话选择列表
显示**各自官方图标**(opencode 用 opencode 的、omp 用 omp 的)。

资源层子卡(#21278 / MON-75)已把官方 SVG 内置进 `assets/harness-icons/<id>.svg`
并登记第三方许可(见 `2026-07-21-harness-icons-assets.md`)。

本条是三层设计里的**模型层**子卡(本工作日志对应的 commit):
为 `harness.Harness` 加 `Icon` 字段,Supported 静态默认填好官方 SVG 资源路径,
经 Wails3 binding 自动透出前端。前端层子卡(#21280)目前 cancelled,
本卡只负责把数据契约建好,不消费。

## 设计

### 字段位置:静态段(不进运行时段)

`Harness` 字段分两组(见 struct 注释):
- 静态(Supported 注册表填):ID / Name / Command —— 现在加 **Icon**,始终有值(对已知 harness 而言)。
- 运行时(Discovered 填):Path / Installed / InstalledVersion / LatestVersion / UpgradeAvailable / UpgradeError —— 这些不动画 Icon。

Icon 是 harness 的**固有品牌属性**(每个 harness 一枚官方图),与「本机装没装 / 能不能升级」
无关 → 归静态段,从 Supported 取,不经 Discover 改写。Discover 沿用现状把 Supported 的
ID/Name/Command **连同样 Icon** 一起拷进运行时返回值(代码不用改:`byID[h.ID] = h` 已经把整个 struct 复制过去了)。

### 字段值:仓库相对资源路径 `assets/harness-icons/<id>.svg`

选项权衡:
- `assets/harness-icons/<id>.svg`(repo 相对路径,选定)
- `/harness-icons/<id>.svg`(URL 形)
- `<id>.svg`(纯文件名)

选 repo 相对路径的理由(§5.3 尊重数据源 + §5.3 KISS):
- **信息保真**:模型层知道的真相是「SVG 文件在 `assets/harness-icons/<id>.svg`」,
  直接照搬,不在模型层臆造前端 URL 布局(`/harness-icons/` 假设前端把它放进 public 根)。
- **不丢信息**:前端层(若复活)拿到 `assets/harness-icons/omp.svg` 后,可自行决定怎么暴露
  (copy 到 public / 走 binding 取字节 / build 时 import),没有任何信息被裁掉。
- **单一事实源**:assets/harness-icons/README.md 的命名约定是「文件名 = harness ID」,
  本字段直接照写,前后端、资源层都对得上,无需中间映射表。

空值语义:Icon == "" 表示「无官方图 / 走兜底」,前端层用 lucide `Bot` 兜底
(见 assets/harness-icons/README.md 已约定的兜底策略)。本卡所有 Supported 项都填了非空值。

### 透出方式:沿用既有 binding,无需新方法

`Harness` 已通过 `ChatService.ListHarnesses / RefreshHarnesses / UpgradeHarness` 三个
导出方法的返回值透出前端(返回 `[]harness.Harness`)。给 struct 加字段后,
`wails3 generate bindings` 重新生成即把 `icon: string` 加进前端 model 类
(`frontend/bindings/.../harness/models.js`,gitignored 中间产物)。

**已验证**:重新跑 `wails3 generate bindings`,生成的 `Harness` class 含 `this["icon"] = ""`
默认值与 JSDoc 注释,前端可直接 `harness.icon` 取值。

## 改了哪些文件

- `internal/harness/harness.go`:
  - `Harness` struct 加 `Icon string \`json:"icon"\``(放在 Command 后、运行时段前)。
  - `Supported` 两条加 `Icon: "assets/harness-icons/<id>.svg"`。
  - 同步更新 struct 顶部 doc(三段→四段)+ Supported 顶部 doc(说明 Icon 单一事实源 = assets/harness-icons/)。
- `internal/harness/harness_test.go`:
  - 新增 `TestSupportedIcons`:校验每个 Supported harness 的 Icon 非空、形如 `assets/harness-icons/<id>.svg`、
    文件名 = ID、路径 `filepath.Clean` 通过(跨平台清洁)。
  - 新增 `TestIconByKnownHarnesses`:锚定 omp/opencode 两个内置 harness 的具体 Icon 值,
    改路径 / 新增 harness 时显式失败提醒同步前端。
- `frontend/bindings/`(gitignored,不入库):`wails3 generate bindings` 重新生成,
  含新的 `icon` 字段。本目录永不入库,仅本地验证用。

## 验证

- `go build ./...` —— 通过(仅 macOS SDK 版本 ld warning,与改动无关)。
  注:`//go:embed all:frontend/dist` 要求 `frontend/dist` 存在才能编译;本地无 dist 时
  建临时 placeholder 验证后清理。
- `go vet ./...` —— 干净。
- `go test ./internal/harness/... -v` —— 全过,含新加的 2 个 test。
- `go test -short ./...` —— 全包通过(chat / store / acp / 等),无回归。
- bindings 重新生成后核对 `frontend/bindings/.../harness/models.js` 含 `icon` 字段 + JSDoc。
- `gofmt -l`:`harness_test.go` 干净。`harness.go` 有 pre-existing 的对齐差异
  (`Installed` / `UpgradeAvailable` 行的注释列多一两个空格,改动前就脏),非本卡引入,
  按 §6.2「不夹带」原则不修。
- `git status` 复核:未夹带 `references/`、`AGENTS.md`、构建产物、RAK 运行时文件。

## 下一步

- 前端层(#21280,目前 cancelled):若复活,做 HarnessIcon 组件按 `harness.icon` 取图,
  未知 / 空值走 lucide `Bot` 兜底;并把 `assets/harness-icons/*.svg` 接入 Vite
  (拷进 `frontend/public/harness-icons/` 或 binding 读字节)。侧栏会话行 + NewSessionModal 接入。
- 明暗主题适配(mark.svg 自带深色底,light 变体仍在 references)留到前端层决定。
