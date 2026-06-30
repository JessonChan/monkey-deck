# docs/worklog/ —— 工作日志(per-file,一条一文件)

每条工作日志一个文件,替代往 PROCESS.md §G 追加。**2026-06-30 起生效。**

## 为什么这么搞

PROCESS.md §G 原来是「最新在上」的单文件追加日志。多个 session 分支同时往
§G 顶部插条目 → 合并时**必然文本冲突**(哪怕内容逻辑上完全无关 —— A 改 composer、
B 加 harness 也撞)。改成 per-file 后,每个分支只新建自己的文件 → **合并零冲突**。

## 文件名约定

```
docs/worklog/YYYY-MM-DD-<slug>.md
```

- `YYYY-MM-DD`:工作日期,作前缀让 `ls` 天然按时间排序(`ls | sort -r` = 最新在上)。
- `<slug>`:短英文 kebab-case 描述(ASCII,git / 排序 / 跨平台友好)。例:
  - `2026-06-30-merge-md-96d8364a-model-select.md`
  - `2026-06-30-interrupt-race-busy.md`
  - `2026-06-30-per-file-worklog.md`
- 关联某次 session 合并时,把 session id(`md/xxxxxxxx`)写进 slug 便于追溯。
- 同一天多条:slug 区分即可,不依赖序号。

## 内容

自包含的一条工作日志,沿用原 §G 条目字段:

- **起因** / **根因(或协议调研、设计)** / **改法** / **改了哪些文件** / **验证** / **下一步**。

第一行用 `# YYYY-MM-DD <标题>` 作 H1,正文用 bullet。

## 读「最近干了啥」

```sh
ls docs/worklog/ | sort -r | head      # 最新在上
cat docs/worklog/<file>.md             # 看某条
```

## 与 PROCESS.md 的分工

- `PROCESS.md` §B(进度快照)/ §C(看板)/ §E(决策)/ §F(OPEN)照常维护 —— 这些是
  「当前状态」,改动频率低、冲突少。
- §B「近期改动汇总」仍可写简要 bullet(指向 worklog 文件),但**详细日志只进本目录**。
- PROCESS.md §G 是**历史归档**,原样保留,不再往里追加。
