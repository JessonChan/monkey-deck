# assets/harness-icons/ —— harness 官方图标资源

每个受支持 ACP harness 一枚**官方 logo**(原样借用,不自绘),供侧栏会话行 /
新建会话选择列表等处展示(monkey-deck MON-75 / 上层需求 #42)。

## 命名约定

```
<harness-id>.svg
```

文件名 = `harness.Harness.ID`(`internal/harness/harness.go` 的 Supported 注册表 ID),
前端按 harness ID 直接归并取图(§5.3):

| 文件 | harness ID | 来源 |
|---|---|---|
| `omp.svg` | `omp`(Oh My Pi) | [oh-my-pi](https://github.com/can1357/oh-my-pi) `assets/icon.svg` |
| `opencode.svg` | `opencode`(OpenCode) | [opencode](https://github.com/anomalyco/opencode) `packages/identity/mark.svg` |

## 兜底(未知 / 第三方 harness)

本目录**不内置兜底图**。未知 / 第三方 harness(没匹配到 `<id>.svg`)由前端用
**lucide `Bot`** 图标兜底(见前端 `lucide-react`),不在 assets 里自绘。
这样:已知 harness 显示各自官方品牌图,未知的一律走中性 Bot,不报错。

## 协议 / 署名

所有 SVG 均自 `references/` 下 MIT 项目原样借用,文件顶部 XML 注释保留原版权声明
与 MIT 许可全文(§0.4 文件级),并在仓库根
[THIRD_PARTY_LICENSES.md](../../THIRD_PARTY_LICENSES.md) §2 登记。

## 维护

- 新增 harness:把官方 logo 原样拷进来命名为 `<id>.svg`,文件头加版权 + MIT 全文,
  并到 THIRD_PARTY_LICENSES.md §2 新增一条。
- **同步镜像到前端 public**:`assets/harness-icons/<id>.svg` 是**唯一事实源**,
  前端运行时通过 Vite 的 `frontend/public/harness-icons/<id>.svg` 镜像访问
  (Vite 把 `public/` 整目录拷进 dist 根,运行时 URL = `/harness-icons/<id>.svg`)。
  新增 / 替换 SVG 后必须**同步拷贝**到 `frontend/public/harness-icons/`(等量副本,
  不修改版权头),否则前端取不到图、走 Bot 兜底。
- **禁止**自研 / 改绘官方 logo(上层需求明确:复用官方品牌,不自研)。
- 改主题适配(明/暗)是前端层职责,不在本目录引入多个变体。
