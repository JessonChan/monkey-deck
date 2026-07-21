# 2026-07-21 内置 harness 官方图标资源 + 登记第三方许可

## 起因

上层需求 #42 / 父卡 MON-74(#21277):不同 harness 在侧栏会话行 + 新建会话选择列表
显示**各自官方图标**(opencode 用 opencode 的、omp 用 omp 的,**不自研**)。

本条是三层设计里的**资源层**子卡(MON-75 / #21278,本工作日志对应的 commit):
把官方 logo 内置进 `assets/harness-icons/`,登记 `THIRD_PARTY_LICENSES.md` 署名(§0.4)。
模型层(Harness.Icon 字段 + binding)、前端层(HarnessIcon 组件)是另外两张子卡,
不在本条范围。

## 设计

- **命名**:`<harness-id>.svg`,直接对齐 `internal/harness/harness.go` Supported 注册表
  的 ID(`omp` / `opencode`)。前端按 harness ID 归并取图(§5.3 KISS),无需中间映射表。
- **原样借用,不自绘**:opencode 用 `packages/identity/mark.svg`,omp 用 `assets/icon.svg`,
  均为各项目官方品牌资源,逐字节拷贝主体,不修改路径/填色/比例。
- **兜底不在本目录**:未知 / 第三方 harness(没匹配到 `<id>.svg`)由前端用
  `lucide-react` 的 `Bot` 兜底 —— 本目录只放已知 harness 的官方图,保持单一职责。
- **协议署名(§0.4)**:两个源项目均为 MIT。原 SVG 无版权头,故在每个 SVG 文件顶部
  追加 XML 注释块(来源 URL + copyright 行 + MIT 许可全文),满足 §0.4 文件级;
  再到 `THIRD_PARTY_LICENSES.md` §2 新增项目级登记条目。

## 改了哪些文件

- `assets/harness-icons/opencode.svg` —— 新增,opencode 官方 mark + MIT 头。
- `assets/harness-icons/omp.svg` —— 新增,oh-my-pi 官方 icon + MIT 头。
- `assets/harness-icons/README.md` —— 新增,命名约定 / 兜底策略 / 维护规则
  (供模型层 + 前端层子卡消费)。
- `THIRD_PARTY_LICENSES.md` —— §2 新增 2.2(opencode.svg)、2.3(omp.svg)两条登记。

## 验证

- 源图核对:`references/opencode/LICENSE` 与 `references/oh-my-pi/LICENSE` 均为 MIT,
  copyright 行照抄进 SVG 头与登记条目。
- `go build ./... && go vet ./... && go test -short ./...`(acceptance gate)—— 通过
  (本卡纯资源 + 文档,无 Go 代码改动,go 侧无回归)。
- `git status` 复核:未夹带 `references/`、`AGENTS.md`、构建产物、RAK 运行时文件。

## 下一步(交接给另外两张子卡)

- **模型层(#21279)**:`harness.Harness` 加 `Icon` 字段;Supported 静态默认填好
  (`omp`/`opencode` 的 Icon 指向本目录对应 SVG 的资源路径);经 Wails3 binding 透出前端。
- **前端层(#21280,目前 cancelled)**:HarnessIcon 组件按 harness ID 取图,未知走 lucide Bot;
  侧栏会话行 + NewSessionModal 接入。
- 明暗主题适配是前端层职责(mark.svg 自带深色底,light 变体 `mark-light.svg` 仍在
  references,若前端需要可在那时再决定是否引入,不本卡内引入多变体以免过度设计)。
