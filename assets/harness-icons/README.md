# assets/harness-icons/ —— harness 官方图标资源

每个受支持 ACP harness 一枚**官方 logo**(原样借用,不自绘),供侧栏会话行 /
新建会话选择列表等处展示(monkey-deck MON-75 / 上层需求 #42)。

## 命名约定

```
<harness-id>.<ext>
```

文件名(去扩展名)= `harness.Harness.ID`(`internal/harness/harness.go` 的 Supported 注册表 ID),
扩展名随**源项目原图格式**(svg 或 png)。前端按 harness ID 逐个尝试扩展名取图(§5.3,
无中间映射表):

| 文件 | harness ID | 来源 |
|---|---|---|
| `omp.png` | `omp`(Oh My Pi) | [oh-my-pi](https://github.com/can1357/oh-my-pi) `python/robomp/assets/icon.png`(robomp 彩色图标) |
| `opencode.svg` | `opencode`(OpenCode) | [opencode](https://github.com/anomalyco/opencode) `packages/identity/mark.svg` |

## 兜底(未知 / 第三方 harness)

本目录**不内置兜底图**。未知 / 第三方 harness(没匹配到 `<id>.<ext>`)由前端用
**lucide `Bot`** 图标兜底(见前端 `lucide-react`),不在 assets 里自绘。
这样:已知 harness 显示各自官方品牌图,未知的一律走中性 Bot,不报错。

## 协议 / 署名

所有图标均自 `references/` 下 MIT 项目原样借用。
**SVG** 在文件顶部 XML 注释保留原版权声明与 MIT 许可全文(§0.4 文件级);
**PNG 等二进制资源**无法内嵌版权头,仅在仓库根
[THIRD_PARTY_LICENSES.md](../../THIRD_PARTY_LICENSES.md) §2 登记项目级署名。
所有借用都在 §2 登记。

## 维护

- 新增 harness:把官方 logo 原样拷进来命名为 `<id>.<ext>`(保留源格式:源是 svg 就 svg,
  是 png 就 png)。svg 在文件头加版权 + MIT 全文;png 无法加文件头则只在
  THIRD_PARTY_LICENSES.md §2 新增一条登记。
- **同步镜像到前端 public**:`assets/harness-icons/<id>.<ext>` 是**唯一事实源**,
  前端运行时通过 Vite 的 `frontend/public/harness-icons/<id>.<ext>` 镜像访问
  (Vite 把 `public/` 整目录拷进 dist 根,运行时 URL = `/harness-icons/<id>.<ext>`)。
  新增 / 替换图标后必须**同步拷贝**到 `frontend/public/harness-icons/`(等量副本,
  不修改内容),否则前端取不到图、走 Bot 兜底。
- **禁止**自研 / 改绘官方 logo(上层需求明确:复用官方品牌,不自研)。
- 改主题适配(明/暗)是前端层职责,不在本目录引入多个变体。
