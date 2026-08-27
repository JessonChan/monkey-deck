#!/usr/bin/env bash
# scripts/coverage-floor.sh — 覆盖率 floor 守门(覆盖率棘轮,ratchet)。
#
# scripts/coverage.floor 记录「总覆盖率的下限」(一行数字),覆盖率只许涨不许跌:
# 总覆盖率 < floor 时本脚本 exit 1,挡住「删测试 / 加不可测代码稀释覆盖率」的静默回归。
# 首次落地:floor = 落地当天实测总覆盖率向下取整(69,实测 69.2% @ go1.x,留 1pt 余量抗工具链噪声)。
#
# 用法:
#   ./scripts/coverage-floor.sh [profile]   校验:总覆盖率 >= floor;低则 exit 1。
#                                           profile 默认 <repo根>/coverage.out(make cover 的产物)。
#   ./scripts/coverage-floor.sh --set       把当前实测总覆盖率写入 floor 文件(涨覆盖后抬杠;
#                                           也用于删码/重构后确认无测试损失时重定基准)。
#   COVERAGE_FLOOR=99 ./scripts/coverage-floor.sh   临时换 floor(如演练失败路径),不落盘。
#
# 口径:覆盖率由 make cover 对 ./internal/... 统计(根 package main 无测试文件,且其
# go:embed 依赖 frontend/dist 构建产物,不计入)。产物 coverage.out / coverage.html 均已 gitignore。
#
# 依赖:go(cover 工具链)、awk(数值比较,不依赖 bc)。也可经 make cover-check 调用。
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
floor_file="$root/scripts/coverage.floor"
profile="$root/coverage.out"
mode="check"

if [[ "${1:-}" == "--set" ]]; then
	mode="set"
elif [[ -n "${1:-}" ]]; then
	profile="$1"
fi

# ── 实测总覆盖率:go tool cover -func 末行 total: (statements) 69.2% ──────────────
total="$(go tool cover -func="$profile" | awk '/^total:/ {gsub(/%/, "", $NF); print $NF}')"
if [[ -z "$total" ]]; then
	echo "coverage-floor: 无法从 $profile 读出总覆盖率(先跑 make cover 生成 coverage.out)" >&2
	exit 1
fi

# ── floor 值:env 覆盖 > floor 文件 ───────────────────────────────────────────────
if [[ -n "${COVERAGE_FLOOR:-}" ]]; then
	floor="$COVERAGE_FLOOR"
elif [[ -f "$floor_file" ]]; then
	floor="$(tr -d '[:space:]' <"$floor_file")"
else
	echo "coverage-floor: 找不到 $floor_file(用 --set 从当前实测生成,或 COVERAGE_FLOOR=NN 临时指定)" >&2
	exit 1
fi

# 数值合法性:必须是 0..100 的数(awk 里 "abc"+0 自比较不等 → 判非法)
if ! awk -v v="$floor" 'BEGIN{exit !(v+0==v && v>=0 && v<=100)}'; then
	echo "coverage-floor: floor 不是合法百分比: '$floor'" >&2
	exit 1
fi

if [[ "$mode" == "set" ]]; then
	printf '%s\n' "$total" >"$floor_file"
	echo "coverage-floor: floor 已更新为 $total($floor_file)"
	exit 0
fi

if awk -v t="$total" -v f="$floor" 'BEGIN{exit !(t+0 >= f+0)}'; then
	echo "coverage-floor: OK 总覆盖率 ${total}% >= floor ${floor}%"
	exit 0
fi
echo "coverage-floor: FAIL 总覆盖率 ${total}% < floor ${floor}% —— 覆盖率棘轮不许倒退:补测试,或确认删码/重构后无测试损失再 --set 重定基准" >&2
exit 1
