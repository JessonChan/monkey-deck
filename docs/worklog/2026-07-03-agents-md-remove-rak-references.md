# 2026-07-03 移除 AGENTS.md 对内部项目 RAK 的参考依赖

## 起因

RAK（real-agent-kanban）是内部项目，无公开版本。AGENTS.md 原把 RAK 当作「ACP client 用法的权威范例 / 直接照搬其生命周期与回调」，并多处「参考 RAK §X」——外部读者/agent 没有 RAK 源码便无法据此工作，这份契约文档因此不可移植。需移除这些依赖，让 AGENTS.md 自洽。

## 改法

- **ACP 用法指引**(§0.1 第3条):由「看 `references/real-agent-kanban/internal/acp/`，直接照搬」改为指向公开的「ACP 协议规范 + `coder/acp-go-sdk`」+ 内部 §1.2/§1.3；删除与之重复的第6条。
- **移除全部「RAK」归属描述**(约 16 处，保留实质内容只去 RAK 归属):§0「不做 RAK 那种」、§1.1「参考 RAK §1.2」、§1.3「照搬 RAK runner.go」、§1.6「RAK handler.go」、§2.2「模仿 RAK 拆」、§3.2「RAK §5.4 #23」「从 RAK 迁移」、§3.4 标题「与 RAK 的关键差异」/「RAK 的无头 daemon」、§5.1「参考 RAK RunnerInterface」、§5.4 标题/引言、§7「那是 RAK」。
- **去掉 real-agent-kanban 出现**:references 项目列表(§0.2、§5.3)、§0.4 借用署名条(整条删)、§0.5「RAK 用 v0.13.5」。
- 「与 RAK 的关键差异」类对比改为通用表述(「与无头 daemon 不同」「那不是我们的定位」)。

## 改了哪些文件

- `AGENTS.md`

## 验证

- `grep "RAK|real-agent-kanban" AGENTS.md` → 0 匹配。
- §0.1 列表删第6条后为 1-5 条，编号自洽；§0.4 删 real-agent-kanban 借用条后剩 wesight/openwork/禁抹声明三条，逻辑完整。
- 纯文档改动，无代码影响。

## 下一步

无。`references/real-agent-kanban` 本机 symlink 仍保留(jessonchan 本地仍可读)，只是 AGENTS.md 不再把它作为对外参考路径写死。
