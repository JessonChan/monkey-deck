#!/bin/sh
# End-to-end installer test harness — runs ON a macOS GitHub Actions runner
# (real /Applications, real codesign/ditto, no local dev machine risk).
#
# Scenarios covered:
#   1. fresh install      — empty /Applications → installer → app present, seal OK, version OK, binary executes
#   2. upgrade            — fabricate an OLD installed app → installer → version replaced, backup cleaned
#   3. up-to-date         — install then re-run → "already up to date", exit 0, no tty hang
#   4. checksum mismatch  — corrupted SHA256SUMS → installer must FAIL (fail-closed)
#   5. missing manifest   — no SHA256SUMS → installer must FAIL
#   6. no .app in archive — zip without .app → installer must FAIL
#   7. broken seal        — bundle tampered post-sign → installer must FAIL
#   8. arch asset         — runner arch maps to the right asset name
#
# The harness pins MD_INSTALL_TAG + MD_INSTALL_BASE at a local file server
# (python3 http.server), so it tests the script's mechanics deterministically
# without touching GitHub's network or rate limits.

set -u

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
INSTALLER="$REPO_ROOT/scripts/install.sh"
APP_PATH="/Applications/Monkey Deck.app"
SRV_PORT="${SRV_PORT:-8931}"

PASS=0; FAIL=0
say() { printf '\033[1;34m[TEST]\033[0m %s\n' "$1"; }
ok()  { printf '\033[1;32m  PASS\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '\033[1;31m  FAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }

check() { # check <label> <want-exit-0-or-1> <cmd...>
  label="$1"; want="$2"; shift 2
  if "$@" >/dev/null 2>&1; then got=0; else got=1; fi
  if [ "$got" = "$want" ]; then ok "$label"; else bad "$label (exit=$got want=$want)"; fi
}

installed_version() {
  /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
    "$APP_PATH/Contents/Info.plist" 2>/dev/null || true
}

# build a signed mini-app (version $1) under directory $2
make_app() { # make_app <version> <destdir>
  v="$1"; d="$2"
  rm -rf "$d"
  mkdir -p "$d/Monkey Deck.app/Contents/MacOS" "$d/Monkey Deck.app/Contents/Resources"
  printf '#!/bin/sh\nwhile true; do sleep 1; done\n' > "$d/Monkey Deck.app/Contents/MacOS/monkey-deck"
  chmod +x "$d/Monkey Deck.app/Contents/MacOS/monkey-deck"
  cp "$REPO_ROOT/build/darwin/Info.plist" "$d/Monkey Deck.app/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $v" \
                          -c "Set :CFBundleVersion $v" \
                          "$d/Monkey Deck.app/Contents/Info.plist"
  codesign --force --deep --sign - "$d/Monkey Deck.app" >/dev/null 2>&1
}

# fabricate the release tree: <dir>/monkey-deck-darwin-<arch>.zip + SHA256SUMS
make_release() { # make_release <dir> <version>
  d="$1"; v="$2"
  make_app "$v" "$d/x"
  ( cd "$d/x" && zip -r -y -q "$d/monkey-deck-darwin-$ARCH.zip" "Monkey Deck.app" )
  ( cd "$d" && shasum -a 256 "monkey-deck-darwin-$ARCH.zip" > SHA256SUMS )
  rm -rf "$d/x"
}

ARCH=$(uname -m)
case "$ARCH" in
  arm64)  ARCH="arm64" ;;
  x86_64) ARCH="amd64" ;;
  *)      echo "unsupported runner arch: $ARCH"; exit 1 ;;
esac
say "runner arch: $ARCH (asset: monkey-deck-darwin-$ARCH.zip)"

# ── local release server ──────────────────────────────────────────────────────
SRV=$(mktemp -d /tmp/md-rel-XXXX)
mkdir -p "$SRV/releases/latest/download"
DL="$SRV/releases/latest/download"
make_release "$DL" "9.9.9"
python3 -m http.server "$SRV_PORT" --directory "$SRV" >/dev/null 2>&1 &
SRV_PID=$!
sleep 1
curl -fsS -o /dev/null "http://127.0.0.1:$SRV_PORT/releases/latest/download/monkey-deck-darwin-$ARCH.zip" \
  || { echo "local release server failed to start"; kill "$SRV_PID"; exit 1; }

export MD_INSTALL_BASE="http://127.0.0.1:$SRV_PORT/releases"
export MD_INSTALL_TAG="v9.9.9"

FINISH() { kill "$SRV_PID" 2>/dev/null; rm -rf "$SRV" "$APP_PATH.new" "$APP_PATH.bak"; }
trap FINISH EXIT

run_installer() { sh "$INSTALLER" </dev/null 2>&1; }

# ══ 1. fresh install ══════════════════════════════════════════════════════════
say "1. fresh install"
rm -rf "$APP_PATH"
OUT=$(run_installer); RC=$?
[ $RC -eq 0 ] && ok "installer exit 0" || bad "installer exit $RC"
[ -d "$APP_PATH" ] && ok "bundle present in /Applications" || bad "bundle missing"
check "seal intact"              0 codesign --verify --deep --strict "$APP_PATH"
check "bundle ad-hoc signed"     0 codesign -dv "$APP_PATH"
[ "$(installed_version)" = "9.9.9" ] && ok "plist version 9.9.9" || bad "plist version '$(installed_version)'"
if xattr -lr "$APP_PATH" 2>/dev/null | grep -q com.apple.quarantine; then
  bad "quarantine present"
else
  ok "no quarantine xattr"
fi
"$APP_PATH/Contents/MacOS/monkey-deck" & LPID=$!
sleep 2
if kill -0 "$LPID" 2>/dev/null; then ok "installed binary executes"; kill "$LPID" 2>/dev/null; else bad "binary fails to execute"; fi
wait "$LPID" 2>/dev/null

# ══ 3. up-to-date (non-interactive, must not hang) ════════════════════════════
say "3. up-to-date re-run"
timeout 30 sh "$INSTALLER" </dev/null >/tmp/up-to-date.log 2>&1
RC=$?
[ $RC -eq 0 ] && ok "exit 0 within 30s (no tty hang)" || bad "exit $RC or hang"
grep -q "already up to date" /tmp/up-to-date.log && ok "reports up-to-date" || bad "missing up-to-date message"

# ══ 2. upgrade path ═══════════════════════════════════════════════════════════
say "2. upgrade v0.0.1 → v9.9.9"
make_app "0.0.1" /tmp/md-old
rm -rf "$APP_PATH"
ditto "/tmp/md-old/Monkey Deck.app" "$APP_PATH"
rm -rf /tmp/md-old
OUT=$(run_installer); RC=$?
[ $RC -eq 0 ] && ok "installer exit 0" || bad "installer exit $RC"
[ "$(installed_version)" = "9.9.9" ] && ok "upgraded to 9.9.9" || bad "upgrade landed '$(installed_version)'"
[ ! -d "$APP_PATH.bak" ] && ok "backup cleaned" || bad "backup left behind"
check "post-upgrade seal" 0 codesign --verify --deep --strict "$APP_PATH"

# ══ 4. checksum mismatch → fail closed ════════════════════════════════════════
say "4. corrupted SHA256SUMS → must fail"
rm -rf "$APP_PATH"
printf '0000000000000000000000000000000000000000000000000000000000000000  monkey-deck-darwin-%s.zip\n' "$ARCH" \
  > "$DL/SHA256SUMS"
OUT=$(run_installer); RC=$?
[ $RC -ne 0 ] && ok "installer refuses (exit $RC)" || bad "installer ACCEPTED corrupt bytes"
[ ! -d "$APP_PATH" ] && ok "nothing installed on failure" || bad "bundle installed despite failure"
make_release "$DL" "9.9.9"

# ══ 5. missing manifest → fail closed ═════════════════════════════════════════
say "5. missing SHA256SUMS → must fail"
mv "$DL/SHA256SUMS" "$SRV/SHA256SUMS.bak"
rm -rf "$APP_PATH"
OUT=$(run_installer); RC=$?
[ $RC -ne 0 ] && ok "installer refuses (exit $RC)" || bad "installer installed without manifest"
mv "$SRV/SHA256SUMS.bak" "$DL/SHA256SUMS"

# ══ 6. archive without .app → must fail ═══════════════════════════════════════
say "6. zip without .app → must fail"
rm -rf "$APP_PATH"
D=$(mktemp -d /tmp/md-noapp-XXXX); mkdir -p "$D/junk"
( cd "$D" && echo hi > junk/hi.txt && zip -r -y -q "$DL/monkey-deck-darwin-$ARCH.zip" junk )
( cd "$DL" && shasum -a 256 "monkey-deck-darwin-$ARCH.zip" > SHA256SUMS )
rm -rf "$D"
OUT=$(run_installer); RC=$?
[ $RC -ne 0 ] && ok "installer refuses (exit $RC)" || bad "installer accepted archive without .app"
make_release "$DL" "9.9.9"

# ══ 7. broken-seal bundle → must fail ═════════════════════════════════════════
say "7. tampered bundle seal → must fail"
rm -rf "$APP_PATH"
D=$(mktemp -d /tmp/md-badseal-XXXX)
make_app "9.9.9" "$D/x"
# tamper AFTER signing: edit the sealed Info.plist so the bundle seal breaks
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString 0.0.0" \
                        "$D/x/Monkey Deck.app/Contents/Info.plist"
( cd "$D/x" && zip -r -y -q "$D/monkey-deck-darwin-$ARCH.zip" "Monkey Deck.app" )
rm -rf "$D/x"
( cd "$D" && shasum -a 256 "monkey-deck-darwin-$ARCH.zip" > SHA256SUMS )
cp "$D/SHA256SUMS" "$D/monkey-deck-darwin-$ARCH.zip" "$DL/"
rm -rf "$D"
OUT=$(run_installer); RC=$?
[ $RC -ne 0 ] && ok "installer refuses (exit $RC)" || bad "installer installed a broken-seal bundle"
make_release "$DL" "9.9.9"

# ══ 8. arch → asset mapping ═══════════════════════════════════════════════════
say "8. arch/asset mapping"
check "asset for this runner arch is fetchable" 0 \
  curl -fsS -o /dev/null "http://127.0.0.1:$SRV_PORT/releases/latest/download/monkey-deck-darwin-$ARCH.zip"
check "wrong-arch asset is absent (installer would fail on it)" 1 \
  curl -fsS -o /dev/null "http://127.0.0.1:$SRV_PORT/releases/latest/download/monkey-deck-darwin-$([ "$ARCH" = arm64 ] && echo amd64 || echo arm64).zip"

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
