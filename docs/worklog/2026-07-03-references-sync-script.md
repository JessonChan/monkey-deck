# 2026-07-03 references/ 同步脚本(清单 + 一键拉取)

## 起因
`references/`(~5GB 外部参考库)整体 `.gitignore`,带来两个痛点:
1. 别人克隆仓库后没有 `references/`,无法跟着 AGENTS.md「参考 references/xxx」走。
2. 很多 AI 编码工具会忽略 `.gitignore` 路径,导致它们也"看不见" `references/`。

## 根因 / 设计选型
外部参考目录不该入库(体积大、非本项目代码),但需要一条**入库的**发现/获取通道。三种方案:
- **git submodule**:❌ 与 `references/` 被 `.gitignore` 冲突(submodule 必须是被跟踪路径),且部分本地副本无 remote 挂不上。
- **纯 README 文档**:❌ 不可执行、易漏。
- **清单 + 同步脚本**:✅ 一份入库清单(URL/协议/用途)+ 一个脚本一键拉取,`references/` 继续忽略,完全符合 §0.2。

清单与脚本入库后:克隆者跑一条命令补齐;AI 工具读脚本顶部的 `REFERENCES` 表即可"看见"参考目录,无需访问 gitignored 内容——这是不破坏 §0.2 的前提下让 AI 工具可发现的唯一办法。

## 改法
- 新增 `scripts/references.sh`:`REFERENCES` 表(名称|URL|路径|协议|用途)为单一事实来源,只列**可公开克隆**的参考;`--list` 打印清单、`--status` 预览、默认浅克隆缺失项、`--pull` 更新、`--full` 完整历史。克隆用 HTTPS(免 SSH key)。`URL=-` 约定预留给本地私有副本(当前无此类条目)。**内部项目 RAK 不入表**(无公开版,写入会令文档不可移植,见 `2026-07-03-agents-md-remove-rak-references.md`);opencode 用确认的 fork `anomalyco/opencode`(非上游 `sst/opencode`)。
- `Taskfile.yml` 加 `references` 任务:`bash scripts/references.sh {{.CLI_ARGS}}`,可 `task references -- --status`。
- `AGENTS.md §0.2` 加一条「获取参考」说明,指向脚本与命令。

## 改了哪些文件
- `scripts/references.sh`(新增)
- `Taskfile.yml`(+references 任务)
- `AGENTS.md`(§0.2 +1 条)
- `docs/worklog/2026-07-03-references-sync-script.md`(本条)

## 验证
- `bash scripts/references.sh --list`:9 条清单正确列出(URL/协议/用途),无 RAK。
- `bash scripts/references.sh --status`:9 个全部 ✓ 已存在,汇总 `已存在 9 / 可克隆缺失 0 / 本地私有缺失 0 / 共 9`;opencode 列为 `anomalyco/opencode`。
- `bash scripts/references.sh`(无参,全已存在):正确 no-op,汇总 `完成:已存在 9,本次克隆 0`。
- `--help`:从标题行正确打印用法块。
- 修复了一处 `set -u` 未定义变量(`--status` 汇总行原引用了不存在的 `$missing`,改为 `clonable_missing` 计数器)。

## 下一步
- `real-agent-kanban`:内部项目无公开版,**已从 `REFERENCES` 表移除**(保持文档可移植,对齐 `2026-07-03-agents-md-remove-rak-references.md`);本机 symlink 仍保留供本地查阅。
- opencode URL 已确认为 fork `anomalyco/opencode`。
- 体积大的探索类参考(vscode 1.6G / sim / wesight 1.9G)是否要默认跳过、`--all` 才拉?目前默认全拉,用户可先 `--status` 预览。按需再决定。
