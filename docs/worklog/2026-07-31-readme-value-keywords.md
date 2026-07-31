# 2026-07-31 README 重写:价值主张 + 搜索关键词 + 双语 + ACP agent 生态清单

## 起因
原 README 只有协议层技术描述(「纯 ACP 桌面客户端」),无价值主张、无搜索关键词命中,
GitHub 搜索搜不到。用户反馈两点,并在多轮讨论中追加要求:
1. 说清项目价值/意义(痛点 → 方案),不只技术描述。
2. 对上搜索关键词(opencode 客户端 / 桌面客户端 / Oh My Pi / Desktop 等)。
3. 默认 README 改英文 + 新增中文版 README.zh-CN.md。
4. 把市面上所有 ACP server 写进 README,强调都可接入 Monkey Deck。
5. 规范品牌用词(OpenCode 等)。
6. 把 ACP 协议官网根链接写进来。

## 讨论结论(用户拍板)
- **英文默认 + 中文版**:GitHub 按浏览器语言自动渲染 `README.<locale>.md`(需在根目录)。
- **Claude Code 不进**:非本产品兼容对象(原生非 ACP);但 Claude Agent(via Zed adapter)
  等「经 adapter」类放,单独归组并标注(与 Claude Code 是不同东西)。
- **ACP server 清单**:合并官网 `get-started/agents` 与 `get-started/registry` 两页,
  标注来源地址(不标日期)。
- **品牌名用各家官方写法**:OpenCode 已查 opencode.ai 确认 O/C 大写;CLI 命令小写
  (`opencode acp` / `omp acp`)。
- **README.zh-CN.md 留根目录**:保 GitHub 自动语言渲染机制(只认根目录/docs 下的
  `README.<locale>.md`),不移子文件夹。

## 改法
- `README.md` 重写为**英文**;新增 `README.zh-CN.md`(**中文**,内容对齐,顶部互指链接)。
- 结构(两版一致):定位 tagline → 为什么做(5 痛点 → 价值映射)→ 核心特点(8 条)→
  **可接入的 ACP agent 生态**(内置 2 / 原生 46 / 经 adapter 4)→ 技术栈 → 搜索关键词 →
  开发 → 参考库 → 致谢 → License。
- **ACP agent 清单**:合并官网 Agents(36)+ Registry(精选)去重共 52 条;内置
  OpenCode / Oh My Pi 单列;经 adapter(Claude Agent / Codex CLI / Pi / Bub)单列;
  来源指向 ACP 官网根站 + Agents + Registry 三个链接。
- **用词规范**:全文 `opencode` → `OpenCode`(14 处,两文件各 7);`Augment Code`
  去掉 `(Auggie CLI)` 括号保持清单格式一致;清单其余品牌名(Codebuddy Code、Amp、
  siGit Code、VT Code、stdio Bus、Docker cagent、Goose、GLM Agent …)照搬官网 Card
  title(agent 作者提交的权威写法),不动。

## 改了哪些文件
- `README.md`(重写英文 + 生态清单 + 用词规范 + 官网根链接)
- `README.zh-CN.md`(新增中文版,同上)
- `docs/worklog/2026-07-31-readme-value-keywords.md`(本条)

## 验证
- OpenCode 官方写法:opencode.ai `<title>` = `OpenCode | The open source AI coding agent`。
- omp = Oh My Pi 且为默认 harness:`internal/harness/harness.go:45`
  `{ID: "omp", Name: "Oh My Pi", Command: "omp acp"}`。
- ACP server 清单来源:agentclientprotocol.com/get-started/agents + /registry(两页 Card title)。
- 全文 grep 小写 `opencode`:仅剩 URL `github.com/sst/opencode`(repo 名,正常),正文/品牌/关键词已全 `OpenCode`。
- 命令核对 Taskfile.yml:`task dev` / `task build` / `task release:darwin` 均存在。
- 未虚构截图/下载链接(尚未发布正式 release)。

## 下一步(OPEN)
- 正式 release 后 README 补「下载 / 安装」区(GitHub Releases 链接 + 平台支持)。
- 可考虑补一张 UI 截图(首屏视觉),素材来自 server 模式浏览器截图(§5.5)。
- ACP 官网清单更新时同步本 README(当前为静态快照)。
