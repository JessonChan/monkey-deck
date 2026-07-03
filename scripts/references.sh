#!/usr/bin/env bash
# scripts/references.sh — 一键拉取 / 同步外部只读参考库到 references/。
#
# references/ 是本地只读参考,永不入库(AGENTS.md §0.2,已整体 .gitignore)。
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

# ── 参考清单(本文件是单一事实来源;改动参考目录就改这里) ──────────────────────────
# 记录格式:名称|URL|相对仓库根路径|协议|用途
# URL = "-" 表示无公开 remote(本地私有副本),脚本不会克隆,需自行放置或软链。
REFERENCES=(
"real-agent-kanban|-|references/real-agent-kanban|本地私有|Go ACP client 生命周期/回调权威范例(AGENTS.md §0.1 #3)"
"openwork|https://github.com/different-ai/openwork.git|references/openwork|MIT(ee/ 除外)|首选 UI/交互蓝本(§4.1),仅参考形态,工作原理不照搬"
"wesight|https://github.com/freestylefly/wesight.git|references/wesight|MIT|UI/产品形态补充灵感(§0.1 #5)"
"orca|https://github.com/stablyai/orca.git|references/orca|MIT|parallel worktree 模型参考(§1.4)"
"opencode|https://github.com/sst/opencode.git|references/opencode|MIT|主 harness(§1.1),ACP 实现参照(本地副本无 remote,URL 按 sst/opencode 填,请核对)"
"agent-client-protocol|https://github.com/agentclientprotocol/agent-client-protocol.git|references/agent-client-protocol|Apache-2.0|ACP 协议规范本体"
"oh-my-pi|https://github.com/can1357/oh-my-pi.git|references/oh-my-pi|MIT|探索参考"
"vscode|https://github.com/microsoft/vscode.git|references/vscode|MIT|探索参考(体积大,建议按需拉取)"
"sim|https://github.com/simstudioai/sim.git|references/sim|见 LICENSE|探索参考(体积大,建议按需拉取)"
"DeepSeek-Reasonix|https://github.com/esengine/DeepSeek-Reasonix.git|references/DeepSeek-Reasonix|MIT|探索参考"
)
# ──────────────────────────────────────────────────────────────────────────────

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="sync"
DEPTH=(--depth 1)
PULL=0
for arg in "$@"; do
  case "$arg" in
    --list)   MODE="list" ;;
    --status) MODE="status" ;;
    --pull)   PULL=1 ;;
    --full)   DEPTH=() ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
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

present=0; cloned=0; missing_remote=0; clonable_missing=0
for rec in "${REFERENCES[@]}"; do
  IFS='|' read -r name url path license purpose <<<"$rec"
  if [ -e "$path" ]; then
    if [ "$MODE" = "status" ]; then
      sha="$(git -C "$path" rev-parse --short HEAD 2>/dev/null || echo "?")"
      printf '%-22s ✓ 已存在  (%s)  %s\n' "$name" "$sha" "$path"
    fi
    if [ "$PULL" = "1" ] && [ "$url" != "-" ]; then
      if git -C "$path" pull --ff-only --quiet 2>/dev/null; then
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
      printf '%-22s ✗ 缺失     %-34s ← %s\n' "$name" "$path" "$url"
    clonable_missing=$((clonable_missing+1))
    else
      printf '%-22s ⬇ 克隆 → %s\n' "$name" "$path"
      if git clone "${DEPTH[@]}" "$url" "$path"; then
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
