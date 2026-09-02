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
| `omp.svg` | `omp`(Oh My Pi) | [oh-my-pi](https://github.com/can1357/oh-my-pi) `packages/collab-web/public/favicon.svg`(彩色渐变 π 图标) |
| `opencode.svg` | `opencode`(OpenCode) | [opencode](https://github.com/anomalyco/opencode) `packages/identity/mark.svg` |

## 已知 agent 图标(README 清单,非内置)

以下为 README 列出的已知 ACP agent 官方 logo,文件名 = harness ID,扩展名随源格式。
与 omp/opencode 内置两条分离:此处仅作「按启动命令关键词匹配 → 自动选 harness」(见
`internal/harness/known.go`)的展示图标,不进 Supported 注册表、不绑定默认 harness 契约。

| 文件 | harness ID(名称) | 来源 |
|---|---|---|
| `agentpool.png` | `agentpool`(AgentPool) | [https://phil65.github.io/agentpool/advanced/acp-integration/](https://phil65.github.io/agentpool/advanced/acp-integration/) |
| `agoragentic.svg` | `agoragentic`(Agoragentic) | [https://agoragentic.com](https://agoragentic.com) |
| `amp.svg` | `amp`(Amp) | [https://github.com/tao12345666333/amp-acp](https://github.com/tao12345666333/amp-acp) |
| `augment-code.png` | `augment-code`(Augment Code) | [https://docs.augmentcode.com/cli/acp](https://docs.augmentcode.com/cli/acp) |
| `autodev.svg` | `autodev`(AutoDev) | [https://github.com/phodal/auto-dev](https://github.com/phodal/auto-dev) |
| `autohand-code.svg` | `autohand-code`(Autohand Code) | [https://www.autohand.ai/cli/](https://www.autohand.ai/cli/) |
| `blackbox-ai.png` | `blackbox-ai`(Blackbox AI) | [https://docs.blackbox.ai/features/blackbox-cli/introduction](https://docs.blackbox.ai/features/blackbox-cli/introduction) |
| `cline.png` | `cline`(Cline) | [https://cline.bot](https://cline.bot) |
| `code-assistant.svg` | `code-assistant`(Code Assistant) | [https://github.com/stippi/code-assistant](https://github.com/stippi/code-assistant) |
| `codebuddy-code.svg` | `codebuddy-code`(Codebuddy Code) | [https://www.codebuddy.cn/cli/](https://www.codebuddy.cn/cli/) |
| `corust-agent.svg` | `corust-agent`(Corust Agent) | [https://corust.ai/](https://corust.ai/) |
| `cortex-code.svg` | `cortex-code`(Cortex Code) | [https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code) |
| `crow-cli.svg` | `crow-cli`(crow-cli) | [https://crow-ai.dev](https://crow-ai.dev) |
| `cursor.svg` | `cursor`(Cursor) | [https://cursor.com/docs/cli/acp](https://cursor.com/docs/cli/acp) |
| `deepagents.png` | `deepagents`(DeepAgents) | [https://docs.langchain.com/oss/javascript/deepagents/overview](https://docs.langchain.com/oss/javascript/deepagents/overview) |
| `devin.png` | `devin`(Devin) | [https://docs.devin.ai/cli](https://docs.devin.ai/cli) |
| `dimcode.png` | `dimcode`(DimCode) | [https://dimcode.dev/docs/acp.html](https://dimcode.dev/docs/acp.html) |
| `dirac.svg` | `dirac`(Dirac) | [https://dirac.run](https://dirac.run) |
| `docker-cagent.png` | `docker-cagent`(Docker cagent) | [https://github.com/docker/cagent](https://github.com/docker/cagent) |
| `fast-agent.svg` | `fast-agent`(fast-agent) | [https://fast-agent.ai/acp](https://fast-agent.ai/acp) |
| `factory-droid.svg` | `factory-droid`(Factory Droid) | [https://factory.ai/](https://factory.ai/) |
| `fount.svg` | `fount`(fount) | [https://github.com/steve02081504/fount](https://github.com/steve02081504/fount) |
| `gemini-cli.svg` | `gemini-cli`(Gemini CLI) | [https://github.com/google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) |
| `github-copilot.svg` | `github-copilot`(GitHub Copilot) | [https://github.com/features/copilot](https://github.com/features/copilot) |
| `glm-agent.svg` | `glm-agent`(GLM Agent) | [https://github.com/stefandevo/glm-acp-agent](https://github.com/stefandevo/glm-acp-agent) |
| `goose.svg` | `goose`(Goose) | [https://block.github.io/goose/](https://block.github.io/goose/) |
| `grok-build.png` | `grok-build`(Grok Build) | [https://x.ai/cli](https://x.ai/cli) |
| `harn.svg` | `harn`(Harn) | [https://harnlang.com](https://harnlang.com) |
| `hermes-agent.png` | `hermes-agent`(Hermes Agent) | [https://hermes-agent.nousresearch.com/docs/user-guide/features/acp](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp) |
| `junie.svg` | `junie`(Junie) | [https://junie.jetbrains.com/](https://junie.jetbrains.com/) |
| `kilo.svg` | `kilo`(Kilo) | [https://kilo.ai/](https://kilo.ai/) |
| `kimi-cli.png` | `kimi-cli`(Kimi CLI) | [https://github.com/MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli) |
| `kiro-cli.svg` | `kiro-cli`(Kiro CLI) | [https://kiro.dev/docs/cli/acp/](https://kiro.dev/docs/cli/acp/) |
| `mistral-vibe.png` | `mistral-vibe`(Mistral Vibe) | [https://github.com/mistralai/mistral-vibe](https://github.com/mistralai/mistral-vibe) |
| `nova.svg` | `nova`(Nova) | [https://www.compassap.ai/portfolio/nova.html](https://www.compassap.ai/portfolio/nova.html) |
| `openclaw.svg` | `openclaw`(OpenClaw) | [https://docs.openclaw.ai/cli/acp](https://docs.openclaw.ai/cli/acp) |
| `openhands.svg` | `openhands`(OpenHands) | [https://docs.openhands.dev/openhands/usage/run-openhands/acp](https://docs.openhands.dev/openhands/usage/run-openhands/acp) |
| `poolside.png` | `poolside`(Poolside) | [https://github.com/poolsideai/pool](https://github.com/poolsideai/pool) |
| `qoder-cli.png` | `qoder-cli`(Qoder CLI) | [https://docs.qoder.com/cli/acp](https://docs.qoder.com/cli/acp) |
| `qwen-code.png` | `qwen-code`(Qwen Code) | [https://github.com/QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) |
| `sigit-code.png` | `sigit-code`(siGit Code) | [https://github.com/getsigit/sigit](https://github.com/getsigit/sigit) |
| `stakpak.png` | `stakpak`(Stakpak) | [https://github.com/stakpak/agent](https://github.com/stakpak/agent) |
| `claude-agent.png` | `claude-agent`(Claude Agent) | [https://claude.ai](https://claude.ai) |
| `codex-cli.png` | `codex-cli`(Codex CLI) | [https://openai.com/codex/](https://openai.com/codex/) |
| `pi.svg` | `pi`(Pi) | [https://github.com/svkozak/pi-acp](https://github.com/svkozak/pi-acp) |
| `bub.png` | `bub`(Bub) | [https://github.com/bubbuild/bub](https://github.com/bubbuild/bub) |

> 4 个 agent 无官方品牌图标(construct / minion-code / stdio-bus / vt-code),不落图,
> 前端走 lucide `Bot` 兜底。

## 兜底(未知 / 第三方 harness)

本目录**不内置兜底图**。未知 / 第三方 harness(没匹配到 `<id>.<ext>`)由前端用
**lucide `Bot`** 图标兜底(见前端 `lucide-react`),不在 assets 里自绘。
这样:已知 harness 显示各自官方品牌图,未知的一律走中性 Bot,不报错。

## 协议 / 署名

本目录图标均取自各项目**官方网站或开源仓库**的官方 logo(非 `references/` 目录),
仅用于界面内标识对应产品。版权与署名统一见同目录
[NOTICE.md](./NOTICE.md):图标所有权归各自项目方,权利方认为侵权可提交 PR 移除。

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
