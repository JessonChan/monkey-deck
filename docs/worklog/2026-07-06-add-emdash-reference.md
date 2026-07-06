# 2026-07-06 新增 emdash 参考到 references 清单

## 起因
用户指出 `https://github.com/generalaction/emdash` 是很好的参考项目,要求加入参考脚本并本地下载。

## 根因 / 调研
emdash(generalaction/emdash,Apache-2.0,YC W26)是**桌面并行 agent 客户端**:
- Electron 桌面应用,本地优先,状态存本地 SQLite;
- 每个任务跑在独立 git worktree + 分支里,可对比 / 合并;
- 适配多家 CLI agent(Claude Code / Codex / OpenCode / Gemini / Amp …)。

形态与本项目高度重合——§1.4(每 session 独占 git worktree)+ §1.5(本地 SQLite 唯一真相)正是 emdash 的核心模型,比 openwork(Electron+SQLite 但 HTTP+SSE)更贴近我们的 worktree 维度。列为**参考**(仅参考形态,工作原理不照搬:emdash 是 CLI 子进程管理,我们是纯 ACP,§1.1)。

## 改法
- `scripts/references.sh` 的 `REFERENCES` 表新增一行(单一事实来源,§0.2),插在 openwork 之后(同为桌面 agent 客户端,主参考维度):
  `emdash|https://github.com/generalaction/emdash.git|references/emdash|Apache-2.0|桌面并行 agent 客户端(Electron+本地 SQLite+每任务 git worktree),形态最贴近本项目(§1.4/§1.5),仅参考形态`
- `references/` 整体 `.gitignore`,emdash 条目不入库;克隆由脚本或手动完成。

## 改了哪些文件
- `scripts/references.sh`(+1 行 REFERENCES 条目)
- `docs/worklog/2026-07-06-add-emdash-reference.md`(本条)

## 验证
- `bash scripts/references.sh --list`:10 条清单正确列出 emdash(URL/协议 Apache-2.0/用途齐全)。
- `git check-ignore references/emdash`:已忽略(确认不入库)。
- `git diff --cached`:仅 1 行新增,无夹带。
- 本地克隆(`references/emdash`)由用户自行完成;脚本自动浅克隆因网络(RPC connection reset)未走通,不影响清单入库——克隆是本机环境行为,清单才是入库的事实来源。

## 下一步
- emdash 的 worktree-per-task 实现值得在阶段 1(session worktree)动手前 read 一遍,对照 orca 的 parallel worktree 模型,取长补短。
- 借用 emdash 任何代码时按 Apache-2.0 署名(版权 + LICENSE 全文 + NOTICE + 标注修改 + THIRD_PARTY_LICENSES 登记,§0.4)。
