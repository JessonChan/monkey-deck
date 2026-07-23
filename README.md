# Monkey Deck

一个纯粹的 **ACP（Agent Client Protocol）桌面客户端**。

通过 ACP 协议驱动实现了 ACP 的编码型 agent（如 opencode / omp），以「项目 / 目录」为单位管理 agent 的对话 session。SQLite 本地落盘，桌面单进程（Wails3）。

## 特点

- **纯 ACP**：与 agent 之间只走 ACP 协议——不解析 CLI stdout，不走 HTTP+SSE。协议一致性是核心赌注。
- **项目 = 目录**：每个 session 钉在一个真实的项目目录上，关掉再开对话还在；并行 session 各占独立 git worktree，互不污染、可对比、可合并。
- **本地优先**：SQLite 是唯一真相来源，无需联网即可读自己的历史。

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
