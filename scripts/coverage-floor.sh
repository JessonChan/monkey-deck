#!/usr/bin/env bash
# scripts/coverage-floor.sh — coverage floor gate (one-way ratchet).
#
# Coverage may only go up. Any measured value below its floor exits 1, blocking
# silent dilution (deleted tests / untestable code). Floors live in two files:
#
#   scripts/coverage.floor        scalar floors, one "<key> <value>" per line:
#                                   go       total statement coverage over ./internal/...
#                                   frontend line coverage over frontend/src (bun lcov)
#   scripts/coverage.floor.pkgs   per-package Go floors, one "<pkg> <value>" per line,
#                                 sorted by package (regenerate with --set-pkgs)
#
# Values are compared numerically, so decimals from re-baselining are fine.
#
# Usage:
#   ./scripts/coverage-floor.sh [profile]   check every floor (default profile <repo>/coverage.out)
#   ./scripts/coverage-floor.sh --set       re-baseline scalar floors (go + frontend) from measurements
#   ./scripts/coverage-floor.sh --set-pkgs  re-baseline per-package floors from the Go profile
#   COVERAGE_FLOOR=NN / COVERAGE_FLOOR_FRONTEND=NN   temporary scalar overrides, not persisted
#
# Re-baselining (after confirmed no test loss, e.g. code deletion) is also the
# documented escape hatch when a toolchain upgrade shifts measurements.
#
# Scope: Go coverage comes from `make cover` over ./internal/... (root package main has no
# tests and its go:embed needs frontend/dist; all testable logic lives in internal/).
# Frontend coverage comes from `bun test --coverage --coverage-reporter=lcov` over frontend/src;
# generated frontend/bindings are excluded from the total (machine-generated, gitignored).
# Artifacts coverage.out / coverage.html / frontend/coverage/ are gitignored.
#
# Depends on: go (cover toolchain), awk (numeric compare, no bc). Called by `make cover-check`.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
floor_file="$root/scripts/coverage.floor"
pkgs_file="$root/scripts/coverage.floor.pkgs"
profile="$root/coverage.out"
lcov_file="$root/frontend/coverage/lcov.info"
mode="check"

if [[ "${1:-}" == "--set" ]]; then
	mode="set"
elif [[ "${1:-}" == "--set-pkgs" ]]; then
	mode="set-pkgs"
elif [[ -n "${1:-}" ]]; then
	profile="$1"
fi

# Numeric helpers: floor must be a number in 0..100 ("abc"+0==abc is false in awk); ge = a >= b.
num_ok() { awk -v v="$1" 'BEGIN{exit !(v+0==v && v>=0 && v<=100)}'; }
ge() { awk -v a="$1" -v b="$2" 'BEGIN{exit !(a+0 >= b+0)}'; }

# Frontend line coverage from lcov: sum LH/LF across records, excluding generated bindings/.
frontend_total_of() {
	[[ -f "$lcov_file" ]] || return 1
	awk '
		/^SF:/           { skip = (substr($0,4) ~ /^bindings\//) }
		/^LF:/           { lf = substr($0,4) }
		/^LH:/           { lh = substr($0,4) }
		/^end_of_record/ { if (!skip) { lfT += lf; lhT += lh } ; lf = lh = 0 }
		END { if (lfT > 0) printf "%.1f", lhT*100/lfT; else exit 1 }
	' "$lcov_file"
}

fail=0

# ── Measured: Go total from `go tool cover -func` last line "total: (statements) 69.2%" ──
total="$(go tool cover -func="$profile" | awk '/^total:/ {gsub(/%/, "", $NF); print $NF}')"
if [[ -z "$total" ]]; then
	exit 1
fi

# ── Measured: per-package aggregate from the profile ────────────────────────────
# Group statement hits by directory (key anchored on /internal/, the pinned scope);
# percentage = covered statements / total statements — matches `go test -cover`
# per-package numbers exactly.
pkg_lines="$(awk '
	/^mode:/ { next }
	{
		loc=$1; sub(/:[0-9.]+,[0-9.]+$/, "", loc)
		dir=loc; sub(/\/[^\/]+$/, "", dir)
		sub(/^.*\/internal\//, "internal/", dir)
		t[dir]+=$2; if ($3>0) c[dir]+=$2
	}
	END { for (d in t) printf "%.1f %s\n", c[d]*100/t[d], d }
' "$profile" | sort -k2,2)"

pkg_count="$(printf '%s\n' "$pkg_lines" | wc -l | tr -d ' ')"

# ── Mode: --set — re-baseline scalar floors (needs frontend lcov too) ───────────
if [[ "$mode" == "set" ]]; then
	fe_set="$(frontend_total_of)" || {
		echo "coverage-floor: 找不到/读不出 $lcov_file(先跑 make cover 生成前端 lcov,再 --set)" >&2
		exit 1
	}
	printf 'go %s\nfrontend %s\n' "$total" "$fe_set" >"$floor_file"
	echo "coverage-floor: floor 已更新: go=${total}% frontend=${fe_set}%($floor_file)"
	exit 0
fi

# ── Mode: --set-pkgs — re-baseline per-package floors (profile only) ────────────
if [[ "$mode" == "set-pkgs" ]]; then
	awk '{print $2, $1}' <<<"$pkg_lines" | sort -k1,1 >"$pkgs_file"
	echo "coverage-floor: 分包 floor 已按实测重定基准(${pkg_count} 包 → $pkgs_file)"
	exit 0
fi

# ── Mode: check ─────────────────────────────────────────────────────────────────
frontend_total="$(frontend_total_of)" || {
	echo "coverage-floor: 找不到/读不出 $lcov_file(先跑 make cover 生成前端 lcov)" >&2
	exit 1
}

# Scalar floors: env override > floor file ("<key> <value>" lines).
if [[ ! -f "$floor_file" ]]; then
	echo "coverage-floor: 找不到 $floor_file(用 --set 从实测生成,或 COVERAGE_FLOOR=NN / COVERAGE_FLOOR_FRONTEND=NN 临时指定)" >&2
	exit 1
fi
floor_key() { awk -v k="$1" '$1==k {print $2}' "$2"; }
floor_go="${COVERAGE_FLOOR:-$(floor_key go "$floor_file")}"
floor_fe="${COVERAGE_FLOOR_FRONTEND:-$(floor_key frontend "$floor_file")}"
if [[ -z "$floor_go" || -z "$floor_fe" ]]; then
	echo "coverage-floor: $floor_file 缺少 go/frontend 行(用 --set 从实测生成,或 COVERAGE_FLOOR=NN / COVERAGE_FLOOR_FRONTEND=NN 临时指定)" >&2
	exit 1
fi
if ! num_ok "$floor_go" || ! num_ok "$floor_fe"; then
	echo "coverage-floor: floor 不是合法百分比: go='$floor_go' frontend='$floor_fe'" >&2
	exit 1
fi

if ge "$total" "$floor_go"; then
	echo "coverage-floor: OK go 总覆盖率 ${total}% >= floor ${floor_go}%"
else
	echo "coverage-floor: FAIL go 总覆盖率 ${total}% < floor ${floor_go}% —— 覆盖率棘轮不许倒退:补测试,或确认删码/重构后无测试损失再 --set 重定基准" >&2
	fail=1
fi

if ge "$frontend_total" "$floor_fe"; then
	echo "coverage-floor: OK 前端行覆盖率 ${frontend_total}% >= floor ${floor_fe}%(frontend/src,不含生成 bindings)"
else
	echo "coverage-floor: FAIL 前端行覆盖率 ${frontend_total}% < floor ${floor_fe}% —— 补测试,或确认无测试损失后 --set 重定基准" >&2
	fail=1
fi

# ── Per-package floors ──────────────────────────────────────────────────────────
if [[ ! -f "$pkgs_file" ]]; then
	echo "coverage-floor: FAIL 找不到 $pkgs_file(用 --set-pkgs 从实测生成)" >&2
	exit 1
fi
pkg_fail=0
while read -r pct dir; do
	[[ -n "$dir" ]] || continue
	f="$(awk -v d="$dir" '$1==d {print $2}' "$pkgs_file")"
	if [[ -z "$f" ]]; then
		echo "coverage-floor: FAIL $dir(${pct}%)无 floor 行 —— 新包也受棘轮约束:bash scripts/coverage-floor.sh --set-pkgs 重新生成,或手工补一行" >&2
		pkg_fail=1
	elif ! num_ok "$f"; then
		echo "coverage-floor: FAIL $pkgs_file 行非法: '$dir $f'" >&2
		pkg_fail=1
	elif ! ge "$pct" "$f"; then
		echo "coverage-floor: FAIL 分包 $dir ${pct}% < floor ${f}% —— 补该包测试,或确认无测试损失后 --set-pkgs 重定基准" >&2
		pkg_fail=1
	fi
done <<<"$pkg_lines"

# Stale floor lines: package no longer in the profile (deleted / renamed).
while read -r dir v; do
	[[ -n "$dir" ]] || continue
	if ! awk -v d="$dir" '$2==d {found=1} END{exit !found}' <<<"$pkg_lines"; then
		echo "coverage-floor: WARN floor 行 $dir 不在本次 profile 里(包已删/改名?)——--set-pkgs 会重写整份文件" >&2
	fi
done <"$pkgs_file"
if [[ $pkg_fail -eq 0 ]]; then
	echo "coverage-floor: OK 分包 floor ${pkg_count}/${pkg_count}(${pkgs_file#$root/})"
fi
fail=$((fail || pkg_fail))

exit "$fail"
