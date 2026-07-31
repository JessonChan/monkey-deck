# Monkey Deck

> 一个纯 ACP 的编码 agent 桌面客户端 —— 把 OpenCode / Oh My Pi (omp) 这类 AI 编程助手,从终端 TUI 变成「以项目为单位、可恢复、可并行、可可视化」的桌面工作台。

**English**: [README.md](README.md)

## 为什么做这个项目

编码型 AI agent(OpenCode、Oh My Pi 等实现了 ACP 的 agent)正成为日常开发的主力工具,但直接用它们有几个真实的痛点:

- **会话是易逝的**:TUI 里的对话关掉就没了,上下文、思考过程、工具调用历史没有项目维度的沉淀,换台机器、换个终端就断片。
- **项目一多就乱**:多项目并行时,所有会话挤在一个工作区里,互相污染 checkout;想对比两个方案的产出,只能手动切来切去。
- **过程是黑盒**:agent 在跑什么工具、写了哪些文件、花了多少 token,全是一坨滚动文本,没有结构化的可视化和审计。
- **权限要么全放行要么全拒绝**:让 agent 自由执行 bash / 写文件不放心,逐个确认又烦人。
- **工具链割裂**:每个 agent 一套交互和上下文,切换成本高。

**Monkey Deck 的价值**:以「项目 / 目录」为单位管理 agent 的对话 session,让多个 ACP agent 在同一个桌面工作台里并行工作、互不污染、随时恢复、全程可见——

- **会话钉在项目上**:每个 session 对应一个真实项目目录,关掉再开对话还在(ACP `session/resume`);数据全部落在本地 SQLite,无需联网即可读自己的历史。
- **并行不互踩**:每个 session 独占一个 git worktree(独立分支),并行实验互不污染,产出可对比、可一键合并回主仓库。
- **有人在场、可交互**:agent 的权限请求(执行 bash / 写文件)以弹窗形式交给你裁决,支持分级规则与「记住本次」——既不放任也不打扰。
- **过程可见、用量可查**:思考、工具调用、model trace、token / 成本用量全部流式呈现,边跑边看。
- **agent 可插拔**:内置 Oh My Pi (omp) / OpenCode,并支持接入任意实现了 ACP 的编码型 agent,接入前先跑 ACP 契约自检。

## 核心特点

- **纯 ACP(Agent Client Protocol)**:与 agent 之间只走 ACP 协议——不解析 CLI stdout,不走 HTTP+SSE。协议一致性是核心赌注:任意实现 ACP 的 harness 都是可互换实例。
- **项目 = 目录**:每个 session 钉在一个真实的项目目录上;并行 session 各占独立 git worktree,互不污染、可对比、可合并。
- **本地优先**:SQLite 是唯一真相来源,无中央 server、无云端依赖。
- **多 harness 可插拔**:内置 Oh My Pi (omp) / OpenCode;「添加 harness」弹窗支持填 stdio ACP 启动命令接入任意 ACP agent,接入前先过 **ACP 契约自检**(ProbeHarness:受控 spawn → Initialize → NewSession → Prompt 跑到 end_turn,产出体检单),Tier1 硬门槛全过才允许添加。
- **权限裁决弹窗**:agent 的 `RequestPermission` 回调弹给用户裁决,分级规则 + 超时兜底,可配自动放行。
- **桌面级体验**:主窗口多标签页、session 可弹成独立窗口、集成终端、消息队列(定时发送)、mermaid 图表渲染、模糊搜索、中英双语界面。
- **稳得住**:崩溃检测 + 断连自动重连(指数退避)、harness 自动升级检测、进程组回收防泄漏。

## 可接入的 ACP agent 生态

Monkey Deck 只说纯 ACP,所以**任何实现了 ACP 的编码 agent 都能接入**。内置 harness 开箱即用;清单里其余 agent 通过「**添加 harness**」弹窗即可接入——粘贴它的 stdio ACP 启动命令,通过 ACP 契约自检,完成。

**内置**

- **Oh My Pi (omp)** — 默认 harness
- **OpenCode**

**原生 ACP agent**(直接实现 ACP,填 stdio 命令即可接入)

- [AgentPool](https://phil65.github.io/agentpool/advanced/acp-integration/)
- [Agoragentic](https://agoragentic.com)
- [Amp](https://github.com/tao12345666333/amp-acp)
- [Augment Code](https://docs.augmentcode.com/cli/acp)
- [AutoDev](https://github.com/phodal/auto-dev)
- [Autohand Code](https://www.autohand.ai/cli/)
- [Blackbox AI](https://docs.blackbox.ai/features/blackbox-cli/introduction)
- [Cline](https://cline.bot/)
- [Code Assistant](https://github.com/stippi/code-assistant)
- [Codebuddy Code](https://www.codebuddy.cn/cli/)
- [Construct](https://github.com/construct-worlds/construct)
- [Corust Agent](https://corust.ai/)
- [Cortex Code](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code)
- [crow-cli](https://crow-ai.dev)
- [Cursor](https://cursor.com/docs/cli/acp)
- [DeepAgents](https://docs.langchain.com/oss/javascript/deepagents/overview)
- [Devin](https://docs.devin.ai/cli)
- [DimCode](https://dimcode.dev/docs/acp.html)
- [Dirac](https://dirac.run)
- [Docker cagent](https://github.com/docker/cagent)
- [fast-agent](https://fast-agent.ai/acp)
- [Factory Droid](https://factory.ai/)
- [fount](https://github.com/steve02081504/fount)
- [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- [GitHub Copilot](https://github.com/features/copilot)
- [GLM Agent](https://github.com/stefandevo/glm-acp-agent)
- [Goose](https://block.github.io/goose/docs/guides/acp-clients)
- [Grok Build](https://x.ai/cli)
- [Harn](https://harnlang.com)
- [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp)
- [Junie](https://junie.jetbrains.com/)
- [Kilo](https://kilo.ai/)
- [Kimi CLI](https://github.com/MoonshotAI/kimi-cli)
- [Kiro CLI](https://kiro.dev/docs/cli/acp/)
- [Minion Code](https://github.com/femto/minion-code)
- [Mistral Vibe](https://github.com/mistralai/mistral-vibe)
- [Nova](https://www.compassap.ai/portfolio/nova.html)
- [OpenClaw](https://docs.openclaw.ai/cli/acp)
- [OpenHands](https://docs.openhands.dev/openhands/usage/run-openhands/acp)
- [Poolside](https://github.com/poolsideai/pool)
- [Qoder CLI](https://docs.qoder.com/cli/acp)
- [Qwen Code](https://github.com/QwenLM/qwen-code)
- [siGit Code](https://github.com/getsigit/sigit)
- [Stakpak](https://github.com/stakpak/agent)
- [stdio Bus](https://github.com/stdiobus/stdiobus)
- [VT Code](https://github.com/vinhnx/vtcode)

**经第三方 adapter 接入**(先装 adapter,再填它的 ACP 启动命令)

- **Claude Agent** — 经 Zed 的 [claude-agent-acp](https://github.com/zed-industries/claude-agent-acp)
- **Codex CLI** — 经 Zed 的 [codex-acp](https://github.com/zed-industries/codex-acp)
- **Pi** — 经 [pi-acp](https://github.com/svkozak/pi-acp)
- **Bub** — 经 [bub-acp-server](https://github.com/bubbuild/bub-contrib/tree/main/packages/bub-acp-server)

清单整理自 [ACP 协议官网](https://agentclientprotocol.com/)的 [Agents](https://agentclientprotocol.com/get-started/agents) 与 [Registry](https://agentclientprotocol.com/get-started/registry) 页面。

## 技术栈

**Wails3** · Go · React 19 + TypeScript · SQLite(modernc.org/sqlite)· bun

## 搜索关键词

*ACP / Agent Client Protocol 客户端 / OpenCode 客户端 / OpenCode 桌面客户端 / Oh My Pi / omp / 编码 agent / AI 编程助手 / 智能体客户端 / harness 管理 / 项目级会话 / git worktree 并行 / 本地优先 / Wails3 桌面应用*

## 开发

```bash
task dev      # 热重载开发(Go + 前端一起)
task build    # 构建桌面应用
task release:darwin  # macOS 打包(DMG + 各架构 updater zip + SHA256SUMS)
go test ./... # 后端单测
```

工程约束、架构方向与阶段规划详见 [AGENTS.md](AGENTS.md)。

### 获取参考库

本项目的 UI / 架构参考了若干开源项目,其本地只读副本(约 5GB,不入库)存放在机器级共享目录(默认 `/tmp/monkey-deck-reference`,见 AGENTS.md §0.2)。克隆本仓库后用一条命令补齐:

```bash
bash scripts/references.sh            # 浅克隆缺失项
bash scripts/references.sh --status   # 预览(不改动)
bash scripts/references.sh --list     # 查看完整清单(URL / 协议 / 用途)
```

## 参考与致谢

感谢以下开源项目(设计参考,非代码复制;借用代码按各项目协议署名,见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)):

- [openwork](https://github.com/different-ai/openwork)(MIT,`ee/` 除外)
- [wesight](https://github.com/freestylefly/wesight)(MIT)
- [orca](https://github.com/stablyai/orca)(MIT)
- [OpenCode](https://github.com/sst/opencode)(MIT)
- [agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol)(Apache-2.0)
- [oh-my-pi](https://github.com/can1357/oh-my-pi)(MIT)

## License

[MIT](LICENSE)
