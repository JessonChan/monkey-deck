# Monkey Deck

一个纯粹的 **ACP（Agent Client Protocol）桌面客户端**。

通过 ACP 协议驱动实现了 ACP 的编码型 agent（如 opencode / omp），以「项目 / 目录」为单位管理 agent 的对话 session。SQLite 本地落盘，桌面单进程（Wails3）。

## 特点

- **纯 ACP**：与 agent 之间只走 ACP 协议——不解析 CLI stdout，不走 HTTP+SSE。协议一致性是核心赌注。
- **项目 = 目录**：每个 session 钉在一个真实的项目目录上，关掉再开对话还在；并行 session 各占独立 git worktree，互不污染、可对比、可合并。
- **本地优先**：SQLite 是唯一真相来源，无需联网即可读自己的历史。

## Harness 适配 / 多 harness 支持

当前 `main` 分支内置 opencode / omp 两个 harness。**多 harness 适配工作在 [`goose-exp`](https://github.com/JessonChan/monkey-deck/tree/goose-exp) 分支推进**，已包含：goose 作为第三个内置 harness、声明即用 harness 向导（用户自定义 harness 命令 + 自检 + 体检）、ACP 契约自检探针 ProbeHarness（接入新 harness 前自动校验协议一致性）。**如需支持更多 harness，请基于该分支继续开发。**

## 参考与致谢

感谢以下开源项目：

- [openwork](https://github.com/different-ai/openwork)（MIT，`ee/` 除外）
- [wesight](https://github.com/freestylefly/wesight)（MIT）
- [orca](https://github.com/stablyai/orca)（MIT）
- [opencode](https://github.com/sst/opencode)（MIT）
- [agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol)（Apache-2.0）
- [oh-my-pi](https://github.com/can1357/oh-my-pi)（MIT）

## 获取参考库

上述项目的本地只读副本约 5GB，**不入库**，存放在机器级共享目录（默认 `/tmp/monkey-deck-reference`，见 AGENTS.md §0.2）。克隆本仓库后用一条命令补齐：

```bash
bash scripts/references.sh            # 浅克隆缺失项
bash scripts/references.sh --status   # 预览（不改动）
bash scripts/references.sh --list     # 查看完整清单（URL / 协议 / 用途）
```

完整说明见 [AGENTS.md](AGENTS.md) §0.2。

## 开发

```bash
task dev      # 热重载开发（Go + 前端一起）
task build    # 构建桌面应用
go test ./... # 后端单测
```

技术栈：**Wails3** · Go · React 19 + TypeScript · SQLite。工程约束、架构方向与阶段规划详见 [AGENTS.md](AGENTS.md)。
