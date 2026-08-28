#!/usr/bin/env bash
# scripts/review-stats.sh — review-throughput stats over docs/worklog review records.
#
# Source of truth: docs/worklog/*.md files whose name contains "review" (the AI dev
# team's review records, one file per review — "preview" is stripped first since it
# embeds "review"). A file is classified as a review record when it carries either
# a 结论 marker (any heading mentioning it — 结论 / 验收结论 / 审查结论 / Review
# 结论总览 — or a bare "结论..." prose verdict line) or a legacy H1 verdict token.
# Review-gap fix follow-ups ("修复 review … 缺口", 落地记录 style) carry neither,
# so they stay excluded.
#
# Fields per record:
#   date    — from the filename YYYY-MM-DD prefix (the worklog convention's invariant;
#             commit dates drift across merge order, filename dates don't).
#   anchor  — first "#NNN" token in the H1 title: the issue/review-cycle id the review
#             is filed under (e.g. "#138" or the reviewer task id like "#24356").
#             MON-xxx style external ids are not matched.
#   verdict — first verdict keyword on the H1, else first inside the conclusion
#             region (PASS / APPROVE / REQUEST[ _-]CHANGES / BLOCKED / 通过).
#             Informational only; implicit-verdict reviews still count.
#
# Usage:
#   ./scripts/review-stats.sh             weekly trend, one row per ISO-8601 week
#                                         (empty weeks between first/last activity
#                                         shown as 0, so gaps stay visible)
#   ./scripts/review-stats.sh --by-issue  per-anchor breakdown, count desc
#
# ISO weeks are computed in pure awk (Monday-based, week 1 contains the first
# Thursday; labeled via the week's Thursday so boundary cases collapse away) —
# no GNU/BSD date divergence.
#
# Exit codes: 0 on success (including zero records), 2 on usage error.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="weekly"

usage() {
	echo "usage: $0 [--by-issue]" >&2
}

case "${1:-}" in
"") ;;
--by-issue) mode="by-issue" ;;
-h|--help) usage; exit 0 ;;
*) usage; exit 2 ;;
esac

shopt -s nullglob
files=("$root"/docs/worklog/*.md)

# ── Pass 1: extract review records → TSV lines "date<TAB>anchor<TAB>verdict" ────
records="$(awk '
	function basename(f,   n, a) { n = split(f, a, "/"); return a[n] }
	FNR == 1 {
		if (pending && sawcon) { print date "\t" anchor "\t" verdict; pending = 0 }
		date = ""; anchor = "-"; verdict = ""; incon = 0; sawcon = 0
		base = basename(FILENAME)
		if (match(base, /[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]/))
			date = substr(base, RSTART, RLENGTH)
		# Strip "preview" before matching: it contains "review" as a substring
		# ("p|review") and would drag preview-feature worklogs into the set.
		lbase = tolower(base); gsub(/preview/, "", lbase)
		if (date == "" || lbase !~ /review/) nextfile
		pending = 1
		if ($0 ~ /^# / && match($0, /#[0-9][0-9]*/))
			anchor = substr($0, RSTART + 1, RLENGTH - 1)
		# Legacy reviews carry the verdict in the H1 itself and no 结论 section,
		# e.g. "# 2026-08-10 Review #83 ... (APPROVE, Task #24257)" — the H1
		# verdict token classifies them too.
		if (match($0, /PASS|APPROVE|REQUEST[ _-]?CHANGES|BLOCKED/)) {
			verdict = substr($0, RSTART, RLENGTH)
			sawcon = 1
		}
	}
	# Conclusion marker: a record is classified as a review when it carries a
	# 结论 marker — any heading mentioning it (结论 / 验收结论 / 审查结论 /
	# Review 结论总览 ...) or a bare "结论..." prose verdict line. Review-gap fix
	# follow-ups ("修复 review … 缺口", 落地记录 style) carry no such marker, so
	# they stay excluded. Verdict keyword is extracted for information only —
	# verdict-less (implicit) reviews still count.
	/^#{1,6}[ \t]/ { incon = ($0 ~ /结论/) ? 1 : 0 }
	/^(\*\*)?结论/ { incon = 1 }
	incon { sawcon = 1 }
	incon && verdict == "" && match($0, /PASS|APPROVE|REQUEST[ _-]?CHANGES|BLOCKED|通过/) {
		verdict = substr($0, RSTART, RLENGTH)
	}
	END { if (pending && sawcon) print date "\t" anchor "\t" verdict }
' "${files[@]}")"

# ── Pass 2: aggregate ────────────────────────────────────────────────────────────
# Day arithmetic (Hinnant civil-date algorithms; 1970-01-01 = day 0). Years in
# play are >= 1970, so int() truncation equals floor division everywhere.
agg_common='
	function dnum(s,   a) { split(s, a, "-"); return days_from_civil(a[1] + 0, a[2] + 0, a[3] + 0) }
	function days_from_civil(y, m, d,    yy, era, yoe, doy, doe) {
		yy = y - ((m <= 2) ? 1 : 0)
		era = int(yy / 400)
		yoe = yy - era * 400
		doy = int((153 * (m + ((m > 2) ? -3 : 9)) + 2) / 5) + d - 1
		doe = yoe * 365 + int(yoe / 4) - int(yoe / 100) + doy
		return era * 146097 + doe - 719468
	}
	function iso_wd(z) { return (z % 7 + 3) % 7 + 1 }  # Mon=1..Sun=7; day 0 = Thursday
	function year_of(z,    n, era, doe, yoe, y, doy) {
		n = z + 719468
		era = int(n / 146097)
		doe = n - era * 146097
		yoe = int((doe - int(doe / 1460) + int(doe / 36524) - int(doe / 146096)) / 365)
		y = yoe + era * 400
		doy = doe - (365 * yoe + int(yoe / 4) - int(yoe / 100))
		return ((int((5 * doy + 2) / 153) >= 10) ? y + 1 : y)
	}
	function iso_label(z) {
		# Thursday identifies the ISO week: no week<1 / week>53 boundary fixups.
		z = z - iso_wd(z) + 4
		return sprintf("%d-W%02d", year_of(z), int((z - days_from_civil(year_of(z), 1, 1) + 1 - 4 + 10) / 7))
	}
	function bar(n,   s) { s = ""; while (n-- > 0) s = s "█"; return s }
'

if [[ "$mode" == "weekly" ]]; then
	printf '%s' "$records" | awk -F '\t' "$agg_common"'
		{
			d = dnum($1); m = d - iso_wd(d) + 1   # Monday anchors the week bucket
			if (gmin == 0 || m < gmin) gmin = m
			if (m > gmax) gmax = m
			cnt[m]++; total++
			if (fmin == "" || $1 < fmin) fmin = $1
			if ($1 > fmax) fmax = $1
		}
		END {
			if (!total) { print "no review records found"; exit 0 }
			for (m = gmin; m <= gmax; m += 7) {
				c = cnt[m] + 0
				printf "%s  %4d  %s\n", iso_label(m), c, bar(c)
			}
			printf "\ntotal %d reviews · %s → %s · %d ISO weeks · avg %.1f/week\n",
				total, fmin, fmax, (gmax - gmin) / 7 + 1, total / ((gmax - gmin) / 7 + 1)
		}
	'
else
	printf '%s' "$records" | awk -F '\t' "$agg_common"'
		{
			cnt[$2]++
			if (!($2 in fmin) || $1 < fmin[$2]) fmin[$2] = $1
			if ($1 > fmax[$2]) fmax[$2] = $1
			total++
		}
		END {
			if (!total) { print "no review records found"; exit 0 }
			for (i in cnt) printf "%6d\t%s\t%s\t%s\n", cnt[i], i, fmin[i], fmax[i]
		}
	' | sort -k1,1nr -k2,2n | awk -F '\t' -v total="$(printf '%s' "$records" | grep -c . || true)" '
		{
			label = ($2 == "-") ? "-" : "#" $2
			printf "%-9s %4d   %s → %s\n", label, $1, $3, $4
		}
		END { printf "\ntotal %d reviews across %d anchors\n", total, NR }
	'
fi
