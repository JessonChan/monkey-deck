#!/usr/bin/env bash
# scripts/references.sh — 一键拉取 / 同步外部只读参考库到机器级共享参考目录。
#
# 外部参考库本地只读、永不入库(AGENTS.md §0.2)。为支持 git worktree 模型(§1.4)
# 下「主检出 + 所有 linked worktree 共享同一份」,参考库放在仓库外的机器级共享目录,
# 而非仓库内 —— 仓库内的 references/ 是 gitignored 的,不会被 checkout 进 linked
# worktree,只有放共享目录才能让任意 worktree 都读到同一份(避免 5GB × N 重复)。
#
# 默认目录:/tmp/monkey-deck-reference(可用环境变量 MONKEY_DECK_REFERENCE_DIR 覆盖)。
# ⚠ /tmp 在 macOS 会被 periodic(daily)回收:默认 3 天未访问即清理,长时间不用会丢。
#    需要持久化请指向稳定目录,例如:
#    MONKEY_DECK_REFERENCE_DIR=~/Library/Caches/monkey-deck-reference ./scripts/references.sh
#
# 克隆者 / AI 编码工具用本脚本获取全部参考;清单(含 URL/协议/用途)即下方 REFERENCES 表。
#
# 用法:
#   ./scripts/references.sh              同步:浅克隆(--depth 1)所有缺失的参考
#   ./scripts/references.sh --full       完整历史克隆(非浅)
#   ./scripts/references.sh --pull       同步 + 更新已存在的(git pull --ff-only)
#   ./scripts/references.sh --status     只看各参考当前状态(不改动)
#   ./scripts/references.sh --list       打印参考清单(名称/URL/协议/用途)
#   ./scripts/references.sh --help       帮助
#
# 也可走 Taskfile:task references -- --status
set -euo pipefail

# ── 参考目录(机器级共享,主检出 + 所有 worktree 共用;env 可覆盖) ───────────────
MD_REF_DIR="${MONKEY_DECK_REFERENCE_DIR:-/tmp/monkey-deck-reference}"
mkdir -p "$MD_REF_DIR"

# ── 参考清单(本文件是单一事实来源;改动参考目录就改这里) ──────────────────────
# 记录格式:名称|URL|$MD_REF_DIR 下子目录|协议|用途
# 「子目录」相对 $MD_REF_DIR(如 openwork → $MD_REF_DIR/openwork)。
# URL = "-" 表示无公开 remote(本地私有副本),脚本不会克隆,需自行放置或软链。
REFERENCES=(
"openwork|https://github.com/different-ai/openwork.git|openwork|MIT(ee/ 除外)|首选 UI/交互蓝本(§4.1),仅参考形态,工作原理不照搬"
"emdash|https://github.com/generalaction/emdash.git|emdash|Apache-2.0|桌面并行 agent 客户端(Electron+本地 SQLite+每任务 git worktree),形态最贴近本项目(§1.4/§1.5),仅参考形态"
"wesight|https://github.com/freestylefly/wesight.git|wesight|MIT|UI/产品形态补充灵感(§0.1 #5)"
"orca|https://github.com/stablyai/orca.git|orca|MIT|parallel worktree 模型参考(§1.4)"
"opencode|https://github.com/anomalyco/opencode.git|opencode|MIT|主 harness(§1.1),ACP 实现参照"
"agent-client-protocol|https://github.com/agentclientprotocol/agent-client-protocol.git|agent-client-protocol|Apache-2.0|ACP 协议规范本体"
"oh-my-pi|https://github.com/can1357/oh-my-pi.git|oh-my-pi|MIT|探索参考"
"vscode|https://github.com/microsoft/vscode.git|vscode|MIT|探索参考(体积大,建议按需拉取)"
"sim|https://github.com/simstudioai/sim.git|sim|见 LICENSE|探索参考(体积大,建议按需拉取)"
"DeepSeek-Reasonix|https://github.com/esengine/DeepSeek-Reasonix.git|DeepSeek-Reasonix|MIT|探索参考"
)
# ──────────────────────────────────────────────────────────────────────────────

MODE="sync"
DEPTH=(--depth 1)
PULL=0
for arg in "$@"; do
  case "$arg" in
    --list)   MODE="list" ;;
    --status) MODE="status" ;;
    --pull)   PULL=1 ;;
    --full)   DEPTH=() ;;
    -h|--help) sed -n '2,/^# 也可走 Taskfile/p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数: $arg(用 --help 查看用法)" >&2; exit 2 ;;
  esac
done

if [ "$MODE" = "list" ]; then
  printf '%-22s %-64s %-16s %s\n' "名称" "URL" "协议" "用途"
  printf '%.0s-' {1..130}; echo
  for rec in "${REFERENCES[@]}"; do
    IFS='|' read -r name url path license purpose <<<"$rec"
    printf '%-22s %-64s %-16s %s\n' "$name" "$url" "$license" "$purpose"
  done
  exit 0
fi

echo "参考目录:$MD_REF_DIR"
present=0; cloned=0; missing_remote=0; clonable_missing=0
for rec in "${REFERENCES[@]}"; do
  IFS='|' read -r name url path license purpose <<<"$rec"
  full="$MD_REF_DIR/$path"
  if [ -e "$full" ]; then
    if [ "$MODE" = "status" ]; then
      sha="$(git -C "$full" rev-parse --short HEAD 2>/dev/null || echo "?")"
      printf '%-22s ✓ 已存在  (%s)  %s\n' "$name" "$sha" "$full"
    fi
    if [ "$PULL" = "1" ] && [ "$url" != "-" ]; then
      if git -C "$full" pull --ff-only --quiet 2>/dev/null; then
        : # ok
      else
        echo "  ↳ $name: pull 失败(可能有本地改动),跳过"
      fi
    fi
    present=$((present+1))
  elif [ "$url" = "-" ]; then
    [ "$MODE" = "status" ] && printf '%-22s ⚠ 缺失且无公开 remote(本地私有,需自行放置/软链)\n' "$name"
    missing_remote=$((missing_remote+1))
  else
    if [ "$MODE" = "status" ]; then
      printf '%-22s ✗ 缺失     %-44s ← %s\n' "$name" "$full" "$url"
      clonable_missing=$((clonable_missing+1))
    else
      printf '%-22s ⬇ 克隆 → %s\n' "$name" "$full"
      if git clone "${DEPTH[@]}" "$url" "$full"; then
        cloned=$((cloned+1))
      else
        echo "  ↳ $name: 克隆失败,跳过(其余继续)"
      fi
    fi
  fi
done

echo "---"
if [ "$MODE" = "status" ]; then
  echo "已存在 $present / 可克隆缺失 $clonable_missing / 本地私有缺失 $missing_remote / 共 ${#REFERENCES[@]}"
else
  echo "完成:已存在 $present,本次克隆 $cloned,本地私有需手动 $missing_remote,共 ${#REFERENCES[@]}"
fi
