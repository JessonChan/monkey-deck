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
#   date    — from the filename YYYY-MM-DD prefix (the worklog convention invariant;
#             commit dates drift across merge order, filename dates do not).
#   anchor  — first "#NNN" token in the H1 title: the issue/review-cycle id the review
#             is filed under (e.g. "#138" or the reviewer task id like "#24356").
#             MON-xxx style external ids are not matched.
#   verdict — first verdict keyword on the H1, else first inside the conclusion
#             region (PASS / APPROVE / REQUEST[ _-]CHANGES / BLOCKED / 通过).
#             Informational only; implicit-verdict reviews still count.
#   severities — distinct P1/P2/P3 levels present anywhere in the record file
#             (whole-file scan, word-boundary validated: "P12"/"XP1" do not match,
#             "P3-a"/"P2/P3" do). Token presence per record, NOT a per-finding
#             count — review write-up formats are heterogeneous (finding slots
#             appear as headings, bold bullets, prose, re-review discussion), so
#             counting slots would be fragile; the stable invariant is level
#             presence (same informational-only philosophy as verdict).
#
# Pass 1 also emits one trailing "#stats<TAB>nscan<TAB>ncand<TAB>nrec" meta line —
# corpus size / filename matches / classified records. Every aggregation skips it;
# it feeds the --overview classification funnel and the --check consistency math.
#
# Counting caliber (pinned): every view — overview total, weekly trend, by-issue,
# by-severity — aggregates the exact same record set produced by pass 1, so all
# reported totals must agree. --overview states the numbers in one place; --check
# enforces the agreement and exits non-zero on drift.
#
# Usage:
#   ./scripts/review-stats.sh             weekly trend, one row per ISO-8601 week
#                                         (empty weeks between first/last activity
#                                         shown as 0, so gaps stay visible)
#   ./scripts/review-stats.sh --overview  counting-caliber summary: classification
#                                         funnel (corpus → candidates → records)
#                                         plus the weekly/by-issue headline counts
#   ./scripts/review-stats.sh --by-issue  per-anchor breakdown, count desc
#   ./scripts/review-stats.sh --by-severity
#                                       P1/P2/P3 grading distribution: how many
#                                       review records mention each level
#   ./scripts/review-stats.sh --check     cross-view caliber guard: all views must
#                                         report the same record total
#
# ISO weeks are computed in pure awk (Monday-based, week 1 contains the first
# Thursday; labeled via the Thursday of the week so boundary cases collapse away) —
# no GNU/BSD date divergence.
#
# Exit codes: 0 on success (including zero records), 1 on --check caliber drift,
# 2 on usage error.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="weekly"

usage() {
	echo "usage: $0 [--overview] [--by-issue] [--by-severity] [--check]" >&2
}

case "${1:-}" in
"") ;;
--overview) mode="overview" ;;
--by-issue) mode="by-issue" ;;
--by-severity) mode="by-severity" ;;
--check) mode="check" ;;
-h|--help) usage; exit 0 ;;
*) usage; exit 2 ;;
esac

shopt -s nullglob
files=("$root"/docs/worklog/*.md)

# ── Pass 1: extract review records → TSV "date<TAB>anchor<TAB>verdict<TAB>sev" ──
# Empty corpus: `set -u` + `"${files[@]}"` on an empty array is an unbound-variable
# crash on stock bash 3.2, and awk with no file args would block reading stdin —
# take the zero-record path instead.
if (( ${#files[@]} == 0 )); then
	records=""
else
	records="$(awk '
	function basename(f,   n, a) { n = split(f, a, "/"); return a[n] }
	function scan_sev(line,   i, tok) {
		# Boundary check folded into one whole-line regex per token. Do NOT
		# extract neighbor chars and regex them: applying a regex to a
		# substr()-extracted piece trips bwk-awk "towc: multibyte conversion
		# failure" under some locales (regex-on-line is safe — the verdict and
		# anchor rules above run on full lines with CJK text). Presence-only,
		# so overlapping matches are irrelevant.
		for (i = 1; i <= 3; i++) {
			tok = "P" i
			if (line ~ "(^|[^A-Za-z0-9])" tok "($|[^A-Za-z0-9])") has[tok] = 1
		}
	}
	function sevstr(   s) {
		s = ""
		if (has["P1"]) s = "P1"
		if (has["P2"]) s = s ((s == "") ? "" : ",") "P2"
		if (has["P3"]) s = s ((s == "") ? "" : ",") "P3"
		return (s == "") ? "-" : s
	}
	FNR == 1 {
		if (pending && sawcon) { print date "\t" anchor "\t" verdict "\t" sevstr(); nrec++ }
		date = ""; anchor = "-"; verdict = ""; incon = 0; sawcon = 0; delete has
		base = basename(FILENAME)
		nscan++
		if (match(base, /[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]/))
			date = substr(base, RSTART, RLENGTH)
		# Strip "preview" before matching: it contains "review" as a substring
		# ("p|review") and would drag preview-feature worklogs into the set.
		lbase = tolower(base); gsub(/preview/, "", lbase)
		if (date == "" || lbase !~ /review/) nextfile
		ncand++
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
	# Severity grading: every line of a candidate record is scanned for P1/P2/P3
	# tokens; boundaries checked in scan_sev. pending files that fail the record
	# classification still scan harmlessly (they are never printed).
	pending { scan_sev($0) }
	END {
		if (pending && sawcon) { print date "\t" anchor "\t" verdict "\t" sevstr(); nrec++ }
		# Funnel meta line: corpus / filename matches / classified records.
		print "#stats\t" nscan + 0 "\t" ncand + 0 "\t" nrec + 0
	}
' "${files[@]}")"
fi

# ── Pass 2: aggregation programs ─────────────────────────────────────────────────
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

# Every aggregation starts by dropping the pass-1 funnel meta line: records
# share the output with it, and counting it would inflate every view by one.
meta_skip='$1 == "#stats" { next }'

prog_weekly="$agg_common"'
	'"$meta_skip"'
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

prog_by_issue="$agg_common"'
	'"$meta_skip"'
	{
		cnt[$2]++
		if (!($2 in fmin) || $1 < fmin[$2]) fmin[$2] = $1
		if ($1 > fmax[$2]) fmax[$2] = $1
		# Union of severity levels across the records of this anchor ($4 =
		# comma list or "-"); keyed as anchor+level (POSIX awk has no 2D arrays).
		if ($4 != "-") {
			ns = split($4, lv, ",")
			for (li = 1; li <= ns; li++) uset[$2 "," lv[li]] = 1
		}
		total++
	}
	END {
		# Zero records: print nothing here — a message line would flow through
		# sort into the format stage and render as a fake row. The format stage
		# owns the zero-record message instead.
		for (i in cnt) {
			s = ""
			if (uset[i ",P1"]) s = "P1"
			if (uset[i ",P2"]) s = s ((s == "") ? "" : ",") "P2"
			if (uset[i ",P3"]) s = s ((s == "") ? "" : ",") "P3"
			if (s == "") s = "-"
			printf "%6d\t%s\t%s\t%s\t%s\n", cnt[i], i, fmin[i], fmax[i], s
		}
	}
'

# Format stage for by-issue: sort → human rows. Sum of per-anchor counts equals
# the record total — the caliber self-evidences in this view (no record dropped
# or double-counted by the grouping).
prog_by_issue_fmt='
	{
		label = ($2 == "-") ? "-" : "#" $2
		printf "%-9s %4d   %s → %s%s\n", label, $1, $3, $4, ($5 == "-") ? "" : "  [" $5 "]"
		tsum += $1
	}
	END {
		if (NR == 0) { print "no review records found" }
		else { printf "\ntotal %d reviews across %d anchors\n", tsum, NR }
	}
'

prog_by_severity='
	'"$meta_skip"'
	{
		total++
		if ($4 == "-") { none++ }
		else { ns = split($4, lv, ","); for (li = 1; li <= ns; li++) cnt[lv[li]]++ }
	}
	END {
		# Records mentioning each P-level. Presence per record — one record
		# that found three P3s counts once, same as one P3 (see header).
		if (!total) { print "no review records found"; exit 0 }
		print "P1/P2/P3 grading — review records mentioning each level"
		for (k = 1; k <= 3; k++) {
			l = "P" k; c = cnt[l] + 0
			printf "%-3s %4d/%-4d %5.1f%%\n", l, c, total, c * 100 / total
		}
		printf "%-3s %4d/%-4d %5.1f%%\n", "-", none + 0, total, none * 100 / total
		printf "\ntotal %d review records\n", total
	}
'

# The pinned counting caliber in one screen: the classification funnel shows
# exactly what is counted (and why candidates drop out); the weekly / by-issue
# lines restate the other headline numbers off the same record set.
prog_overview="$agg_common"'
	$1 == "#stats" { ns = $2 + 0; nc = $3 + 0; nr = $4 + 0; next }
	{
		total++
		if (fmin == "" || $1 < fmin) fmin = $1
		if ($1 > fmax) fmax = $1
		d = dnum($1); m = d - iso_wd(d) + 1
		if (wmin == 0 || m < wmin) wmin = m
		if (m > wmax) wmax = m
		if ($2 == "-") { unanch++ }
		else {
			# Max anchor, ties broken by smaller id: deterministic display.
			if (++a[$2] > amax || (a[$2] == amax && ($2 + 0) < (atop + 0))) { amax = a[$2]; atop = $2 }
		}
	}
		END {
			if (!total) { print "no review records found"; exit 0 }
			for (k in a) na++   # distinct non-unanchored anchors
		printf "corpus      %d worklog files under docs/worklog\n", ns
		printf "candidates  %d filename matches (date prefix + \"review\", \"preview\" stripped)\n", nc
		printf "records     %d candidates carrying a conclusion marker — every view counts exactly these\n", nr
		printf "excluded    %d candidates without a marker (fix follow-ups / implementation logs)\n", nc - nr
		printf "span        %s → %s\n", fmin, fmax
		printf "weekly      %d reviews · %d ISO weeks · %s → %s\n",
			total, (wmax - wmin) / 7 + 1, iso_label(wmin), iso_label(wmax)
		printf "by-issue    %d reviews · %d anchors", total, na
		if (unanch) printf " · %d unanchored", unanch
		if (atop != "") printf " · max #%s=%d", atop, amax
		printf "\n"
		printf "\ntotal %d reviews\n", total
	}
'

mode_weekly() {
	printf '%s' "$records" | awk -F '\t' "$prog_weekly"
}

mode_overview() {
	printf '%s' "$records" | awk -F '\t' "$prog_overview"
}

mode_by_issue() {
	printf '%s' "$records" | awk -F '\t' "$prog_by_issue" | sort -k1,1nr -k2,2n | awk -F '\t' "$prog_by_issue_fmt"
}

mode_by_severity() {
	printf '%s' "$records" | awk -F '\t' "$prog_by_severity"
}

case "$mode" in
weekly) mode_weekly ;;
overview) mode_overview ;;
by-issue) mode_by_issue ;;
by-severity) mode_by_severity ;;
esac
