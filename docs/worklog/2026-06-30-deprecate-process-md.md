# 2026-06-30 docs:废止 PROCESS.md 维护,开发追踪统一走 docs/worklog

## 起因
用户决定「PROCESS.md 以后不要维护了,主要在 worklog 中记录开发过程」。此前 PROCESS.md 承载进度快照 / 看板 / 决策 / OPEN / 工作日志多重职责,更新成本高、§G 已有合并冲突前科(见 `docs/worklog/README.md` 缘起);per-file worklog 机制已于 2026-06-30 建立。

## 改法
开发过程的**唯一活载体**改为 `docs/worklog/`(一条一文件);PROCESS.md 全文冻结为历史归档(只读,不再写)。AGENTS.md 相关规则同步:
- §0.1 阅读顺序:开工必读从 `PROCESS.md` 改为 `docs/worklog/` 最近几条(`ls docs/worklog/ | sort -r | head`)。
- §0.3 整章重写:标题改「开发追踪:docs/worklog/(PROCESS.md 已停维)」;原 4 步循环收敛为 3 步(对齐 → 执行 → 收工记录);明确「禁止往 PROCESS.md 写新内容」;决策 / OPEN / 踩坑都并进当次 worklog 条目。
- §2.1 目录树:`PROCESS.md` 注释标「历史归档(只读;2026-06-30 起停维)」,补 `docs/worklog/` 行。
- §6.2 收工即提交:同步更新 PROCESS.md → 在 `docs/worklog/` 新增工作日志。
- §8 自检清单 2 条:开工读 worklog / 收工写 worklog。
- `docs/worklog/README.md`「与 PROCESS.md 的分工」节(原写「§B/§C/§E/§F 照常维护」,与新策略冲突)→ 改为「PROCESS.md 已停维」,明确全节冻结、唯一活载体是本目录。
- `PROCESS.md` 顶部加 ⚠️ 停维声明(改走 worklog、不再写新内容、原「必读 / 必更新」要求废止);原说明保留为历史,§A 旧 4 步循环被顶部声明覆盖框定为废止。

## 改了哪些文件
- `AGENTS.md`(§0.1 / §0.3 / §2.1 / §6.2 / §8)。
- `PROCESS.md`(顶部停维声明)。
- `docs/worklog/README.md`(「分工」节重写)。

## 验证
纯文档改动,无需构建 / 测试。grep 全项目核对:无残留「维护 / 更新 PROCESS.md」指令与本次改动矛盾(命中的均为停维声明本身,或 PROCESS.md §A 旧文 —— 后者已被顶部声明覆盖)。
