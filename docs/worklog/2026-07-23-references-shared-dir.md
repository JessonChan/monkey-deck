# 2026-07-23 外部参考库迁至机器级共享目录 /tmp/monkey-deck-reference

## 起因

外部参考库(~5GB)一直放在仓库内 `references/`(gitignored)。本项目 session 走 git worktree 模型(§1.4):linked worktree **不包含** gitignored 的 `references/`——agent 在 worktree 里 cwd 下根本读不到 `references/`,「参考 references/xxx」在 worktree 语境下是死路径。每个 worktree 若各自拉一份又是 `5GB × N` 的浪费。用户要求:参考库改放机器级共享目录 `/tmp/monkey-deck-reference`,主检出 + 所有 worktree 共用同一份。

## 根因 / 设计选型

- **放仓库外绝对路径**:git worktree 只 checkout 被跟踪路径,gitignored 的 `references/` 不会进 linked worktree。机器级共享绝对路径(`/tmp/monkey-deck-reference`)让任意 worktree / 主检出都指向同一份,零重复。
- **默认 `/tmp` + env 覆盖**:遵循用户指定默认 `/tmp/monkey-deck-reference`;加环境变量 `MONKEY_DECK_REFERENCE_DIR` 可覆盖(脚本 + 文档统一)。⚠ 已知权衡:macOS `/tmp`(`private/tmp`)会被 periodic(daily)回收(默认 3 天未访问即清理),长时间不用可能丢;需要持久化用 env 指向稳定目录(如 `~/Library/Caches/monkey-deck-reference`)。权衡已在 AGENTS.md §0.2 与脚本头注明。
- **保留 `references/<name>` 记法**:历史 worklog / 代码注释 / THIRD_PARTY_LICENSES 大量出现 `references/xxx`,逐处改写成本高且会篡改历史记录;改为在 §0.2 一次性重定义「`references/<name>` 指 `$MD_REF_DIR/<name>`」,向后兼容所有旧记法。
- **`references/` 在 `.gitignore` 保留**:作防御性安全网(仓库内本不该再出现,若误建则拦下)。

## 改法

1. **数据迁移**:`mv references /tmp/monkey-deck-reference`(同卷 `/System/Volumes/Data`,瞬间 rename,5.5G 含 `real-agent-kanban` 绝对软链,迁移后软链仍有效)。
2. **`scripts/references.sh`** 重写:
   - 新增 `MD_REF_DIR="${MONKEY_DECK_REFERENCE_DIR:-/tmp/monkey-deck-reference}"` + `mkdir -p`;删除原 `ROOT`/`cd "$ROOT"`(不再仓库相对)。
   - `REFERENCES` 表「路径」列由仓库相对路径(`references/openwork`)改为 `$MD_REF_DIR` 下子目录名(`openwork`);循环用 `full="$MD_REF_DIR/$path"`。
   - 头注释说明共享目录理由 + `/tmp` 回收权衡 + env 覆盖用法;`--help` 用 `sed '2,/^# 也可走 Taskfile/p'` 稳定锚点。
3. **AGENTS.md**:§0.2 重写(共享目录定义 + 为什么不放仓库内 + `/tmp` 权衡);§2.1 目录树删除 `references/` 行;§6.3 改写;§8 自检清单两项更新。
4. **README.md / Taskfile.yml / .gitignore**:同步新位置说明。
5. **移除 `internal/chat/study_test.go`**(见下)。

## 附:移除 `internal/chat/study_test.go`

迁移前发现该文件第 45 行 `cwd := "references/wesight"` 是参考库路径在**运行时(测试)的唯一硬依赖**。核查后判定它不是真测试:
- build tag `integration`(`//go:build integration`),默认与 CI 都跳过;脚手架初始提交(`44338eb`)引入的实验。
- 拿 wesight 当 cwd,起**真 harness**(写死 `zai/glm-4.6`),开 3 session × 10 题 = 30 轮 LLM 对话,让 agent 自动回答「wesight 是什么/架构/功能」并写文件。
- **零断言**:只 `writeLine`/`t.Log`,从不因对错失败,不守护任何 monkey-deck 契约;注释还写错(`/tmp/study-answers.txt` vs 实际 `t.TempDir`)。
- `studyQ`/`studyClip`/`TestStudyWesight` 全包内无外部引用。

属「让 LLM 帮我读 wesight 生成学习笔记」的一次性脚手架实验,按 KISS / Less is More 删除。删后运行时对 `references/` 路径零依赖,迁移只剩 docs + 脚本。同包 `error_code_test.go` 的 `SendAndWaitSync` 用法是真契约测试(peer-disconnect 错误码),保留。

## 改了哪些文件

- `internal/chat/study_test.go`(删除)
- `scripts/references.sh`(重写)
- `AGENTS.md`、`README.md`、`Taskfile.yml`、`.gitignore`(文档/配置)
- `docs/worklog/2026-07-23-references-shared-dir.md`(本条)

## 验证

- `bash scripts/references.sh --status`:参考目录 `/tmp/monkey-deck-reference`,9 已存在 / 1 缺失(emdash 之前就未克隆成功,预期)/ 共 10;路径全为 `$MD_REF_DIR/<name>`。
- `--list` / `--help` / `MONKEY_DECK_REFERENCE_DIR` 覆盖均正常。
- `go test ./internal/chat/ -count=1`:`ok 3.168s`(删除 study_test.go 后)。
- `references/` 已从仓库根移除;`/tmp/monkey-deck-reference` 5.5G 完整。

## 下一步

- 若长期不用参考库被 `/tmp` 回收,重跑 `bash scripts/references.sh` 即可补齐;介意可 `export MONKEY_DECK_REFERENCE_DIR=~/Library/Caches/monkey-deck-reference`。
- `internal/acp/proc.go` 注释「照搬 references/real-agent-kanban/...」是历史遗留(`real-agent-kanban` 早已不在 REFERENCES 清单),本次未动,可择机清理。
