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
#             "P3-a"/"P2/P3" do). Token presence per record — feeds the record
#             caliber views (--by-issue level union, --by-severity).
#   findings — per-finding counts, one TSV column per level (p1/p2/p3). Per
#             line, a multiplier annotation expands the count ("P3×4" /
#             "2×P1" = N findings; both directions occur in the corpus, ×
#             being the only separator seen); bare repeats of the same level
#             on one line are the same finding restated and count once
#             (line-level dedup). The line is the dedup unit by design: a
#             tally restated across H1 / conclusion / body lines counts
#             again, and "无 P1" negations or subscripted siblings
#             ("P3-a/P3-b") sharing one line are known distortions — read
#             findings totals as ordered magnitude, not exact issue counts.
#
# Pass 1 also emits one trailing "#stats<TAB>nscan<TAB>ncand<TAB>nrec" meta line —
# corpus size / filename matches / classified records. Every aggregation skips it;
# it feeds the --overview classification funnel and the --check consistency math.
#
# Counting caliber (pinned): every view — overview total, weekly trend, by-issue,
# by-severity — aggregates the exact same record set produced by pass 1, so all
# reported record totals must agree. Findings numbers (per-finding P1/P2/P3)
# carry the same cross-view agreement between the weekly trend and --overview.
# The findings headline line — "findings    P1 a/P2 b/P3 c · 未分级 n篇/总 N篇=记录数"
# — reports per-finding counts for the graded levels while 未分级/总 carry 篇
# (record) units: 总N篇 IS the record total, not the findings sum. --overview
# prints it once and the default weekly view repeats it byte-identical as its
# first line; --check enforces the agreement and exits non-zero on drift.
#
# Gate status: informational only. Nothing in the build / test / coverage / CI
# chain invokes this script, and no acceptance gate consumes its output or exit
# code — --check's exit 1 is a caliber-drift alarm for the human reading the
# numbers, not a gate input.
#
# Usage:
#   ./scripts/review-stats.sh             weekly trend, one row per ISO-8601 week
#                                         (empty weeks between first/last activity
#                                         shown as 0, so gaps stay visible); the
#                                         first line is the corpus-wide findings
#                                         headline (shared with --overview), each
#                                         week row carries per-finding P1/P2/P3
#                                         counts plus the review count "(n篇)"
#   ./scripts/review-stats.sh --overview  counting-caliber summary: classification
#                                         funnel (corpus → candidates → records),
#                                         the weekly/by-issue headline counts and
#                                         the per-finding severity line
#   ./scripts/review-stats.sh --by-issue  per-anchor breakdown, count desc
#   ./scripts/review-stats.sh --by-severity
#                                       P1/P2/P3 grading distribution: how many
#                                       review records mention each level
#   ./scripts/review-stats.sh --check     cross-view caliber guard: all views must
#                                         report the same record total, the
#                                         findings numbers must agree across the
#                                         weekly trend and --overview, and the
#                                         findings line's 总N篇 must equal the
#                                         record total
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

# ── Pass 1: extract review records → TSV "date<TAB>anchor<TAB>verdict<TAB>sev<TAB>p1<TAB>p2<TAB>p3" ──
# Empty corpus: `set -u` + `"${files[@]}"` on an empty array is an unbound-variable
# crash on stock bash 3.2, and awk with no file args would block reading stdin —
# take the zero-record path instead.
if (( ${#files[@]} == 0 )); then
	records=""
else
	records="$(awk '
	function basename(f,   n, a) { n = split(f, a, "/"); return a[n] }
	function isalnum(c) { return index("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", c) > 0 }
	function ltrim(s) { while (length(s) > 0 && (substr(s, 1, 1) == " " || substr(s, 1, 1) == "\t")) s = substr(s, 2); return s }
	function rtrim(s) { while (length(s) > 0 && (substr(s, length(s), 1) == " " || substr(s, length(s), 1) == "\t")) s = substr(s, 1, length(s) - 1); return s }
	function endstok(s,   t) {
		# Boundary-valid P token ending s, else "". String ops only: running a
		# regex on a substr()-cut piece trips bwk-awk "towc: multibyte
		# conversion failure" under some locales (worklog 26766) — so the
		# boundary check is an index() lookup, and a cut continuation byte
		# simply fails the alnum test, which is the correct boundary verdict.
		s = rtrim(s)
		if (length(s) < 2) return ""
		t = substr(s, length(s) - 1)
		if (t != "P1" && t != "P2" && t != "P3") return ""
		if (length(s) > 2 && isalnum(substr(s, length(s) - 2, 1))) return ""
		return t
	}
	function startstok(s,   t) {
		s = ltrim(s)
		if (length(s) < 2) return ""
		t = substr(s, 1, 2)
		if (t != "P1" && t != "P2" && t != "P3") return ""
		if (length(s) > 2 && isalnum(substr(s, 3, 1))) return ""
		return t
	}
	function leaddigits(s,   c, i, n) {
		s = ltrim(s); n = ""
		for (i = 1; i <= length(s); i++) {
			c = substr(s, i, 1)
			if (index("0123456789", c) == 0) break
			n = n c
		}
		return n + 0
	}
	function traildigits(s,   c, n) {
		s = rtrim(s); n = ""
		while (length(s) > 0) {
			c = substr(s, length(s), 1)
			if (index("0123456789", c) == 0) break
			n = c n
			s = substr(s, 1, length(s) - 1)
		}
		return n + 0
	}
	function scan_mul(line,   j, num, tok) {
		# Sum the ×N multiplier annotations per level, both directions observed
		# in the corpus ("P2×2" and "2×P3"; × U+00D7 is the only separator
		# seen). Split on × and validate each side of every boundary with the
		# string-op helpers above — never a regex on a derived piece. A bare
		# occurrence later in the line adds nothing extra (line-level dedup:
		# the same finding restated), which is why scan_sev only consumes the
		# sum.
		delete mul
		np = split(line, pc, /×/)
		for (j = 2; j <= np; j++) {
			num = leaddigits(pc[j])
			if (num > 0 && (tok = endstok(pc[j - 1])) != "") mul[tok] += num
			num = traildigits(pc[j - 1])
			if (num > 0 && (tok = startstok(pc[j])) != "") mul[tok] += num
		}
	}
	function scan_sev(line,   i, tok) {
		# Boundary check folded into one whole-line regex per token. Do NOT
		# extract neighbor chars and regex them: applying a regex to a
		# substr()-extracted piece trips bwk-awk "towc: multibyte conversion
		# failure" under some locales (regex-on-line is safe — the verdict and
		# anchor rules above run on full lines with CJK text).
		scan_mul(line)
		for (i = 1; i <= 3; i++) {
			tok = "P" i
			if (line ~ "(^|[^A-Za-z0-9])" tok "($|[^A-Za-z0-9])") {
				has[tok] = 1
				# Per-finding caliber: multiplier annotations expand the
				# count, bare repeats on one line are the same finding and
				# count once.
				cnt[tok] += (mul[tok] > 0) ? mul[tok] : 1
			}
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
		if (pending && sawcon) { print date "\t" anchor "\t" verdict "\t" sevstr() "\t" cnt["P1"] + 0 "\t" cnt["P2"] + 0 "\t" cnt["P3"] + 0; nrec++ }
		date = ""; anchor = "-"; verdict = ""; incon = 0; sawcon = 0; delete has; delete cnt
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
	# tokens (presence into has, per-finding counts into cnt); boundaries checked
	# in scan_sev. pending files that fail the record classification still scan
	# harmlessly (they are never printed).
	pending { scan_sev($0) }
	END {
		if (pending && sawcon) { print date "\t" anchor "\t" verdict "\t" sevstr() "\t" cnt["P1"] + 0 "\t" cnt["P2"] + 0 "\t" cnt["P3"] + 0; nrec++ }
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
# The findings headline line, printed byte-identical by --overview and as the
# default weekly view's first row — one printf, two insertions, zero drift.
# P1/P2/P3 are per-finding counts; 未分级/总 carry 篇 (record) units with 总
# pinned to the record total ("=记录数"), not the findings sum.
findings_line='printf "findings    P1 %d/P2 %d/P3 %d · 未分级 %d篇/总 %d篇=记录数\n", f1, f2, f3, un, total'

prog_weekly="$agg_common"'
	'"$meta_skip"'
	{
		d = dnum($1); m = d - iso_wd(d) + 1   # Monday anchors the week bucket
		if (gmin == 0 || m < gmin) gmin = m
		if (m > gmax) gmax = m
		cnt[m]++; total++
		wp1[m] += $5; wp2[m] += $6; wp3[m] += $7   # per-finding sums, one column per level
		f1 += $5; f2 += $6; f3 += $7               # corpus-wide sums for the headline line
		if ($4 == "-") un++                        # records with zero graded findings
		if (fmin == "" || $1 < fmin) fmin = $1
		if ($1 > fmax) fmax = $1
	}
	END {
		if (!total) { print "no review records found"; exit 0 }
		'"$findings_line"'
		for (m = gmin; m <= gmax; m += 7) {
			c = cnt[m] + 0
			printf "%s  P1 %d/P2 %d/P3 %d(%d篇)  %s\n", iso_label(m), wp1[m] + 0, wp2[m] + 0, wp3[m] + 0, c, bar(c)
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
		f1 += $5; f2 += $6; f3 += $7
		if ($4 == "-") { un++ }   # records with no graded finding — the ungraded bucket
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
		'"$findings_line"'
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

mode_check() {
	# Cross-view caliber guard: run every view, parse the totals each one
	# REPORTS, and fail loudly on drift. This tests what a consumer actually
	# sees (not just the shared TSV), so an edit to any single aggregation
	# cannot silently change one view's numbers without the others.
	# Findings numbers (per-finding P1/P2/P3) get the same treatment: the
	# weekly and overview views must report identical per-level sums, the
	# default view's headline line must equal --overview's findings line
	# byte-for-byte, and that line's 总N篇 must equal the record total (总 is
	# record-caliber, never the findings sum; 未分级 cannot exceed it).
	local w b s o tsv meta nscan ncand nrec
	local wt ws wp1 wp2 wp3 bt bs st ot op1 op2 op3 oun oft wvf fail=0
	w="$(mode_weekly)"
	b="$(mode_by_issue)"
	s="$(mode_by_severity)"
	o="$(mode_overview)"

	tsv="$(printf '%s' "$records" | awk -F '\t' '$1 != "#stats"' | grep -c . || true)"
	meta="$(printf '%s' "$records" | awk -F '\t' '$1 == "#stats" { print $2 + 0, $3 + 0, $4 + 0 }')"
	read -r nscan ncand nrec <<<"${meta:-0 0 0}"

	wt="$(awk '$1 == "total" { t = $2 + 0 } END { print t + 0 }' <<<"$w")"
	ws="$(awk '$1 ~ /^[0-9][0-9][0-9][0-9]-W[0-9][0-9]$/ && match($0, /\([0-9]+/) { s += substr($0, RSTART + 1, RLENGTH - 1) } END { print s + 0 }' <<<"$w")"
	wkl() {
		# "P1 <n>/"-style slot on a week row: ASCII-bounded match, so the digit
		# slice after the 3-char "P1 " prefix is locale-safe. Note -v takes a
		# single name=value argument in bwk-awk.
		awk -v "lvl=$1" '$1 ~ /^[0-9][0-9][0-9][0-9]-W[0-9][0-9]$/ && match($0, lvl " [0-9]+") { s += substr($0, RSTART + 3, RLENGTH - 3) } END { print s + 0 }' <<<"$w"
	}
	wp1="$(wkl P1)"; wp2="$(wkl P2)"; wp3="$(wkl P3)"
	bt="$(awk '$1 == "total" { t = $2 + 0 } END { print t + 0 }' <<<"$b")"
	bs="$(awk '$1 ~ /^#/ || $1 == "-" { s += $2 } END { print s + 0 }' <<<"$b")"
	st="$(awk '$1 == "total" { t = $2 + 0 } END { print t + 0 }' <<<"$s")"
	ot="$(awk '$1 == "total" { t = $2 + 0 } END { print t + 0 }' <<<"$o")"
	ovf="$(awk '$1 == "findings" { print }' <<<"$o")"
	# The default view's first line IS the findings headline — parse it too,
	# so a broken corpus-sum accumulation in the weekly aggregation cannot
	# drift it away from --overview's line unnoticed.
	wvf="$(awk '$1 == "findings" { print }' <<<"$w")"
	op1="$(awk 'match($0, /P1 [0-9]+/) { print substr($0, RSTART + 3, RLENGTH - 3) }' <<<"$ovf")"
	op2="$(awk 'match($0, /P2 [0-9]+/) { print substr($0, RSTART + 3, RLENGTH - 3) }' <<<"$ovf")"
	op3="$(awk 'match($0, /P3 [0-9]+/) { print substr($0, RSTART + 3, RLENGTH - 3) }' <<<"$ovf")"
	# 总 N: anchored on the CJK label (the line ends with "=记录数", so a
	# tail-digit match would find nothing); 未分级 n likewise. Both walk back
	# over the trailing ASCII digit run of the matched region — no regex on a
	# derived piece (bwk-awk towc trap); the walk only ever touches ASCII.
	oft="$(awk 'match($0, /总 [0-9]+/) { i = RSTART + RLENGTH - 1; d = ""; while (i >= 1 && index("0123456789", substr($0, i, 1)) > 0) { d = substr($0, i, 1) d; i-- } print d + 0 }' <<<"$ovf")"
	oun="$(awk 'match($0, /未分级 [0-9]+/) { i = RSTART + RLENGTH - 1; d = ""; while (i >= 1 && index("0123456789", substr($0, i, 1)) > 0) { d = substr($0, i, 1) d; i-- } print d + 0 }' <<<"$ovf")"

	ck() {
		if [[ "$2" != "$3" ]]; then
			printf 'FAIL %-20s %s (expected %s)\n' "$1" "$3" "$2"
			fail=1
		else
			printf 'ok  %-20s %s\n' "$1" "$2"
		fi
	}

	echo "caliber check — every view must count the same record set"
	ck "tsv records" "$tsv" "$tsv"
	ck "funnel nrec" "$tsv" "$nrec"
	if (( nscan >= ncand && ncand >= nrec )); then
		printf 'ok  %-20s %s >= %s >= %s\n' "funnel ordering" "$nscan" "$ncand" "$nrec"
	else
		printf 'FAIL %-20s %s >= %s >= %s\n' "funnel ordering" "$nscan" "$ncand" "$nrec"
		fail=1
	fi
	ck "weekly total" "$tsv" "$wt"
	ck "weekly bucket sum" "$tsv" "$ws"
	ck "by-issue total" "$tsv" "$bt"
	ck "by-issue anchor sum" "$tsv" "$bs"
	ck "by-severity total" "$tsv" "$st"
	ck "overview total" "$tsv" "$ot"
	ck "findings P1" "${op1:-0}" "${wp1:-0}"
	ck "findings P2" "${op2:-0}" "${wp2:-0}"
	ck "findings P3" "${op3:-0}" "${wp3:-0}"
	ck "weekly headline" "$ovf" "$wvf"
	ck "findings total=recs" "$tsv" "${oft:-0}"
	if (( ${oun:-0} <= ${oft:-0} )); then
		printf 'ok  %-20s %s <= %s\n' "ungraded<=total" "${oun:-0}" "${oft:-0}"
	else
		printf 'FAIL %-20s %s <= %s\n' "ungraded<=total" "${oun:-0}" "${oft:-0}"
		fail=1
	fi

	if (( fail )); then
		echo "check FAILED — counting caliber drifted between views"
		exit 1
	fi
	echo "check ok"
}

case "$mode" in
weekly) mode_weekly ;;
overview) mode_overview ;;
by-issue) mode_by_issue ;;
by-severity) mode_by_severity ;;
check) mode_check ;;
esac
