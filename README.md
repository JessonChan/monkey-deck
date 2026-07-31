# Monkey Deck

> A desktop client for **ACP (Agent Client Protocol)** coding agents — turning OpenCode / Oh My Pi (omp) from terminal TUIs into a project-based, resumable, parallel, visual workbench.

**中文版**: [README.zh-CN.md](README.zh-CN.md)

## Why this project

AI coding agents (OpenCode, Oh My Pi, and other ACP-implementing agents) are becoming daily drivers for development, but using them raw has real pain points:

- **Sessions are ephemeral**: conversations in a TUI are gone when the terminal closes. Context, reasoning, and tool-call history never accumulate per project.
- **Many projects, much chaos**: with multiple projects running in parallel, every session shares one working tree and pollutes each other's checkout; comparing two approaches means manually switching back and forth.
- **The process is a black box**: what tools the agent ran, which files it changed, how many tokens it spent — all a scrolling wall of text with no structured visibility or audit trail.
- **Permissions are all-or-nothing**: letting an agent freely run bash / write files is unsettling; confirming every single action is exhausting.
- **Fragmented tooling**: each agent has its own interaction model and its own context; switching costs add up.

**What Monkey Deck does**: manages agent chat sessions per **project / directory**, so multiple ACP agents work in parallel in one desktop workbench — isolated, resumable, always visible:

- **Sessions pinned to projects**: each session is anchored to a real project directory and survives closing the app (ACP `session/resume`). All data lives in local SQLite — your history is readable without a network.
- **Parallel without interference**: each session gets its own git worktree (dedicated branch), so parallel experiments never pollute each other; results can be compared and merged back with one click.
- **A human in the loop**: agent permission requests (run bash / write files) surface as dialogs for you to decide, with tiered rules and "remember this" — neither unrestricted nor nagging.
- **Visible process, measurable spend**: reasoning, tool calls, model trace, and token / cost usage stream into the UI as they happen.
- **Pluggable agents**: Oh My Pi and OpenCode are built in; any ACP-implementing agent can be added with a stdio command — gated by an ACP conformance self-check before it's allowed in.

## Features

- **Pure ACP (Agent Client Protocol)**: the only channel between the app and an agent is ACP — no CLI stdout parsing, no HTTP+SSE. Protocol conformance is the core bet: any ACP-implementing harness is an interchangeable instance.
- **Project = directory**: every session is anchored to a real project directory; parallel sessions each occupy an isolated git worktree — no interference, comparable, mergeable.
- **Local-first**: SQLite is the single source of truth. No central server, no cloud dependency.
- **Pluggable harnesses**: Oh My Pi (omp) and OpenCode built in; the "Add harness" dialog accepts any ACP agent via a stdio ACP command, gated by an ACP conformance self-check (ProbeHarness: controlled spawn → Initialize → NewSession → Prompt to `end_turn`, producing a report). Tier-1 gates must all pass before the harness is added.
- **Permission dialogs**: agent `RequestPermission` callbacks surface to you for a decision — tiered rules, timeout fallback, configurable auto-allow.
- **Desktop-grade experience**: multi-tab main window, pop-out session windows, integrated terminal, message queue with scheduled send, mermaid rendering, fuzzy search, Chinese/English UI.
- **Stays up**: crash detection + auto-reconnect with exponential backoff, harness auto-upgrade checks, process-group reclamation against leaks.

## Compatible ACP agents

Monkey Deck speaks pure ACP, so **every agent that implements the Agent Client Protocol can be plugged in**. The built-ins work out of the box; every other agent below can be added in seconds from the **Add harness** dialog — paste its stdio ACP command, pass the ACP conformance self-check, done.

**Built-in**

- **Oh My Pi (omp)** — default harness
- **OpenCode**

**Native ACP agents** (implement ACP directly, add via stdio command)

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

**Via third-party adapters** (install the adapter, then add its ACP command)

- **Claude Agent** — via Zed's [claude-agent-acp](https://github.com/zed-industries/claude-agent-acp)
- **Codex CLI** — via Zed's [codex-acp](https://github.com/zed-industries/codex-acp)
- **Pi** — via [pi-acp](https://github.com/svkozak/pi-acp)
- **Bub** — via [bub-acp-server](https://github.com/bubbuild/bub-contrib/tree/main/packages/bub-acp-server)

Curated from the [ACP protocol site](https://agentclientprotocol.com/) — the [Agents](https://agentclientprotocol.com/get-started/agents) and [Registry](https://agentclientprotocol.com/get-started/registry) pages.

## Tech stack

**Wails3** · Go · React 19 + TypeScript · SQLite (modernc.org/sqlite) · bun

## Search keywords

*ACP / Agent Client Protocol client / OpenCode client / OpenCode GUI / Oh My Pi / omp / coding agent client / AI coding agent desktop app / agent harness manager / project-based sessions / git worktree parallel / local-first / Wails3 desktop app*

## Development

```bash
task dev      # hot-reload development (Go + frontend together)
task build    # build the desktop app
task release:darwin  # macOS packaging (DMG + per-arch updater zips + SHA256SUMS)
go test ./... # backend unit tests
```

Engineering constraints, architecture direction, and roadmap live in [AGENTS.md](AGENTS.md).

### Reference library

The UI / architecture references a set of open-source projects; their local read-only copies (~5 GB, not committed) live in a machine-level shared directory (default `/tmp/monkey-deck-reference`, see AGENTS.md §0.2). After cloning, pull them with one command:

```bash
bash scripts/references.sh            # shallow-clone missing entries
bash scripts/references.sh --status   # preview (no changes)
bash scripts/references.sh --list     # full list (URL / license / purpose)
```

## Acknowledgments

Thanks to the following open-source projects (design references, not code copies; borrowed code is attributed per each project's license in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)):

- [openwork](https://github.com/different-ai/openwork) (MIT, `ee/` excluded)
- [wesight](https://github.com/freestylefly/wesight) (MIT)
- [orca](https://github.com/stablyai/orca) (MIT)
- [OpenCode](https://github.com/sst/opencode) (MIT)
- [agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol) (Apache-2.0)
- [oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT)

## License

[MIT](LICENSE)
