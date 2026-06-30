# 2026-06-30 工作日志改 per-file(docs/worklog/)

- **起因**:连续合并 `md/13e08a19`、`md/96d8364a`、`md/d4d163ac` 三个 session 分支,
  每次都在 PROCESS.md §G(「最新在上」的单文件追加日志)撞文本冲突 —— 多分支同时往
  §G 顶部插条目,即使内容逻辑无关也必然冲突。用户要求根治,拍板「不拆分 PROCESS.md,
  后续 per-file」。
- **根因**:append-mostly 日志放单文件 + 所有并发分支写同一插入点(§G 顶部)→ git
  文本级冲突 unavoidable。属于结构问题,不是写法问题。
- **改法**:
  - 新建 `docs/worklog/`,**每条工作日志一个文件**(`YYYY-MM-DD-<slug>.md`)。分支只
    新建自己的文件 → 零冲突。约定见 `docs/worklog/README.md`。
  - **PROCESS.md 现有 §G 原样保留作历史归档**,不再追加;新条目一律进 `docs/worklog/`。
    §G 标题加指针说明。
  - `AGENTS.md` §0.3(4 步循环 step 3/4)+ §8 自检清单、`PROCESS.md` §A(step 3/4)的
    「收工」纪律改为「新增一个 worklog 文件」,不再「§G 追加一条」。
- **改了哪些文件**:`docs/worklog/{README.md(新), 2026-06-30-per-file-worklog.md(新)}`、
  `AGENTS.md`(§0.3 step 3/4 + §8)、`PROCESS.md`(§A step 3/4 + §G 标题)。
- **验证**:纯文档改动,无代码 / 无构建。`ls docs/worklog/` 可见 README + 本条。
- **下一步 / 残留冲突面**:① 后续每次工作按新约定写 worklog 文件,观察是否还有
  PROCESS.md 冲突;② §B「近期改动汇总」仍是潜在**低频**小冲突面(各分支都想往顶部加
  一行 bullet),暂保留 —— 若再频繁撞,同样可改成「每分支一个 bullet 文件」或干脆删掉
  (它本就是 §G/worklog 的摘要副本)。
