#!/bin/sh
# monkey-deck installer / updater — macOS + Linux (Windows: not supported yet)
#
# Usage: curl -fsSL <distribution-url>/install.sh | sh
#
# Design notes:
#  - Zero api.github.com calls. Version comes from the /releases/latest
#    redirect target; artifacts come from /releases/latest/download/<name>
#    (stable file names — assets carry no version in their names).
#    No rate limits, so no second-tier manifest is needed.
#  - macOS: installs the SAME per-arch zip the in-app updater consumes —
#    one distribution surface, byte-identical to auto-update installs.
#  - Linux: installs the distro-native package (deb on dpkg systems,
#    rpm on dnf/zypper/yum systems); no package manager → manual hint.
#  - Verifies every artifact against the release's SHA256SUMS, fails closed.
#  - macOS quarantine-free by construction: curl downloads carry no
#    quarantine bit and the copy never goes through LaunchServices, so
#    the ad-hoc signature suffices. The xattr strip below is defensive only.
#  - Reads installed version via PlistBuddy on macOS (NOT `defaults` —
#    cfprefd caches stale negatives for freshly written bundles; measured),
#    and via dpkg/rpm on Linux.
#  - Test hooks: MD_INSTALL_BASE overrides the download root (local file
#    server), MD_INSTALL_TAG pins the release tag (skips redirect resolve).

set -e

REPO="jessonchan/monkey-deck"          # keep in sync with internal/update.GitHubRepository
BUNDLE_ID="com.jessonchan.monkeydeck"  # build/darwin/Info.plist
APP_PATH="/Applications/Monkey Deck.app"
BIN_NAME="monkey-deck"                 # CFBundleExecutable / deb binary name
BASE="${MD_INSTALL_BASE:-https://github.com/$REPO/releases}"
MANUAL_URL="https://github.com/$REPO/releases/latest"

CYAN=$(printf '\033[0;36m')
GREEN=$(printf '\033[0;32m')
GRAY=$(printf '\033[0;90m')
YELLOW=$(printf '\033[0;33m')
RED=$(printf '\033[0;31m')
RESET=$(printf '\033[0m')

die() {
  echo "  ${RED}$1${RESET}"
  if [ -n "$2" ]; then echo "  ${YELLOW}$2${RESET}"; fi
  exit 1
}

echo ""
echo "  ${CYAN}monkey-deck installer${RESET}"
echo "  ${GRAY}──────────────────────────${RESET}"

OS=$(uname -s)
ARCH=$(uname -m)
case "$OS" in
  Darwin|Linux) : ;;
  *)            die "Unsupported OS: $OS" "monkey-deck ships macOS and Linux builds; Windows is not supported yet." ;;
esac
# ── latest version (via redirect, no API) ────────────────────────────────────
# MD_INSTALL_TAG pins the release tag (e.g. v0.1.0) — skips the redirect
# resolution; used by CI to test a fixed release without depending on
# which release happens to be latest.
if [ -n "$MD_INSTALL_TAG" ]; then
  LATEST_TAG="$MD_INSTALL_TAG"
else
  echo "  ${GRAY}Resolving latest version...${RESET}"
  FINAL_URL=$(curl -fsSL -o /dev/null -w '%{url_effective}' "$BASE/latest" 2>/dev/null || true)
  LATEST_TAG=${FINAL_URL##*/tag/}
fi
if [ -z "$LATEST_TAG" ] || [ "$LATEST_TAG" = "$FINAL_URL" ]; then
  die "Could not resolve the latest release." "Check your network, or download manually: $MANUAL_URL"
fi
LATEST_VER=${LATEST_TAG#v}

# ── download + verify into TMPD ──────────────────────────────────────────────
TMPD=$(mktemp -d "${TMPDIR:-/tmp}/monkey-deck-install.XXXXXX")
trap 'rm -rf "$TMPD"' EXIT

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi
}

# fetch_verified <asset-name>: download asset + SHA256SUMS, verify, fail closed.
fetch_verified() {
  asset="$1"
  echo "  ${GRAY}Downloading $asset ...${RESET}"
  if ! curl -fL --progress-bar --retry 5 --retry-all-errors --retry-delay 2 \
          "$BASE/latest/download/$asset" -o "$TMPD/$asset"; then
    die "Download failed." "Retry later, or download manually: $MANUAL_URL"
  fi
  if ! curl -fsSL "$BASE/latest/download/SHA256SUMS" -o "$TMPD/SHA256SUMS"; then
    die "Checksum manifest (SHA256SUMS) is missing from the release." "Refusing to install unverified bytes."
  fi
  WANT=$(grep " $asset" "$TMPD/SHA256SUMS" | tail -1 | awk '{print $1}')
  GOT=$(hash_file "$TMPD/$asset" | awk '{print $1}')
  if [ -z "$WANT" ] || [ "$WANT" != "$GOT" ]; then
    die "Checksum mismatch for $asset" "expected ${WANT:-<no entry>}, got $GOT — the download is corrupt; retry."
  fi
}

# up_to_date_exit: shared "already latest" path. Pause only when there is a
# real interactive stdin (double-clicked .command) so CI / `curl | sh` never
# blocks on a read.
up_to_date_exit() {
  echo ""
  echo "  ${GREEN}monkey-deck is already up to date (v$1).${RESET}"
  echo ""
  if [ -r /dev/tty ] && [ -t 0 ]; then
    printf '  %sPress Enter to continue...%s' "$GRAY" "$RESET"
    read -r _ < /dev/tty
    echo ""
  fi
  exit 0
}

# ═════════════════════════════════════════════════════════════════ macOS ════
if [ "$OS" = "Darwin" ]; then

  # A shell running under Rosetta 2 reports x86_64 on Apple Silicon; prefer
  # the native arm64 build when the hardware supports it.
  if [ "$ARCH" = "x86_64" ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = "1" ]; then
    ARCH="arm64"
  fi
  case "$ARCH" in
    arm64)  ASSET_ARCH="arm64" ;;
    x86_64) ASSET_ARCH="amd64" ;;
    *)      die "Unsupported architecture: $ARCH" ;;
  esac
  ASSET="monkey-deck-darwin-$ASSET_ARCH.zip"

  # ── installed version ──────────────────────────────────────────────────────
  INSTALLED_VER=""
  if [ -d "$APP_PATH" ]; then
    INSTALLED_VER=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP_PATH/Contents/Info.plist" 2>/dev/null || true)
  fi
  if [ -n "$INSTALLED_VER" ]; then
    echo "  ${GRAY}Installed : v$INSTALLED_VER${RESET}"
    if [ "$INSTALLED_VER" = "$LATEST_VER" ]; then up_to_date_exit "$INSTALLED_VER"; fi
    echo "  ${YELLOW}Upgrading v$INSTALLED_VER → v$LATEST_VER ...${RESET}"
  else
    echo "  ${GRAY}Not installed — performing fresh install of v$LATEST_VER ...${RESET}"
  fi

  fetch_verified "$ASSET"

  # ── unpack + integrity ─────────────────────────────────────────────────────
  echo "  ${GRAY}Unpacking...${RESET}"
  ditto -x -k "$TMPD/$ASSET" "$TMPD/x"
  APP=$(find "$TMPD/x" -maxdepth 2 -name "*.app" | head -1)
  if [ -z "$APP" ]; then
    die "No .app bundle found inside the archive."
  fi
  if command -v codesign >/dev/null 2>&1; then
    if ! codesign --verify --deep --strict "$APP" 2>/dev/null; then
      die "Bundle signature check failed." "The download is damaged; retry."
    fi
  fi
  # ── quit a running instance before touching its bundle ────────────────────
  if pgrep -x "$BIN_NAME" >/dev/null 2>&1; then
    echo "  ${GRAY}Asking monkey-deck to quit...${RESET}"
    osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
    WAITED=0
    while pgrep -x "$BIN_NAME" >/dev/null 2>&1 && [ "$WAITED" -lt 25 ]; do
      sleep 0.2
      WAITED=$((WAITED + 1))
    done
    if pgrep -x "$BIN_NAME" >/dev/null 2>&1; then
      die "monkey-deck is still running." "Quit it (⌘Q) and re-run this installer."
    fi
  fi

  # ── install: stage → backup → swap → restore on failure ───────────────────
  echo "  ${GRAY}Installing to /Applications...${RESET}"
  SUDO=""
  if [ ! -w /Applications ]; then SUDO="sudo"; fi
  NEW="$APP_PATH.new"
  BAK="$APP_PATH.bak"
  $SUDO rm -rf "$NEW" "$BAK"
  if ! $SUDO ditto "$APP" "$NEW"; then
    $SUDO rm -rf "$NEW"
    die "Failed to copy the new bundle into /Applications."
  fi
  if [ -d "$APP_PATH" ]; then
    if ! $SUDO mv "$APP_PATH" "$BAK"; then
      $SUDO rm -rf "$NEW"
      die "Failed to move the old bundle aside."
    fi
  fi
  if $SUDO mv "$NEW" "$APP_PATH"; then
    $SUDO rm -rf "$BAK"
  else
    if [ -d "$BAK" ]; then $SUDO mv "$BAK" "$APP_PATH"; fi
    die "Failed to place the new bundle; the previous version was restored."
  fi

  # Defensive: strip quarantine in case any download path tagged the files
  # (curl itself does not; this covers browser-adjacent re-runs).
  $SUDO xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null || true

  echo ""
  echo "  ${GREEN}Done! monkey-deck v$LATEST_VER installed.${RESET}"
  echo "  ${GRAY}Launch it from /Applications or Spotlight.${RESET}"
  echo ""

# ══════════════════════════════════════════════════════════════════ Linux ═══
elif [ "$OS" = "Linux" ]; then

  case "$ARCH" in
    x86_64)         ASSET_ARCH="amd64" ;;
    aarch64|arm64)  ASSET_ARCH="arm64" ;;
    *)              die "Unsupported architecture: $ARCH" ;;
  esac

  # ── package manager detection: deb → rpm → manual ─────────────────────────
  # Arch/NixOS/Alpine users fall through to the manual hint on purpose:
  # shipping distro-specific packages for every family is out of scope for now.
  PKG=""
  RPM_INSTALL=""
  if command -v dpkg >/dev/null 2>&1; then
    PKG="deb"
  elif command -v dnf >/dev/null 2>&1; then
    PKG="rpm"; RPM_INSTALL="dnf install -y"
  elif command -v zypper >/dev/null 2>&1; then
    PKG="rpm"; RPM_INSTALL="zypper --non-interactive install"
  elif command -v yum >/dev/null 2>&1; then
    PKG="rpm"; RPM_INSTALL="yum install -y"
  elif command -v rpm >/dev/null 2>&1; then
    PKG="rpm"; RPM_INSTALL="rpm -i --replacepkgs"
  fi
  if [ -z "$PKG" ]; then
    die "No supported package manager found (dpkg or rpm family)." \
        "Download manually: $MANUAL_URL"
  fi
  ASSET="monkey-deck-linux-$ASSET_ARCH.$PKG"

  # ── installed version ──────────────────────────────────────────────────────
  INSTALLED_VER=""
  if [ "$PKG" = "deb" ]; then
    INSTALLED_VER=$(dpkg -s "$BIN_NAME" 2>/dev/null | sed -n 's/^Version: //p' | head -1)
  else
    INSTALLED_VER=$(rpm -q --queryformat '%{VERSION}' "$BIN_NAME" 2>/dev/null || true)
  fi
  if [ -n "$INSTALLED_VER" ]; then
    if [ "$INSTALLED_VER" = "$LATEST_VER" ]; then up_to_date_exit "$INSTALLED_VER"; fi
    echo "  ${YELLOW}Upgrading v$INSTALLED_VER → v$LATEST_VER ...${RESET}"
  else
    echo "  ${GRAY}Not installed — performing fresh install of v$LATEST_VER ...${RESET}"
  fi

  fetch_verified "$ASSET"

  # ── install via package manager ───────────────────────────────────────────
  # No quit-running dance here: dpkg/rpm replace binaries atomically enough
  # (unlink + rename), and a running process keeps its old inode — the
  # running app is unaffected until the user restarts it.
  SUDO=""
  if [ "$(id -u)" != "0" ]; then
    command -v sudo >/dev/null 2>&1 \
      || die "Root rights are required to install the package, and sudo was not found."
    SUDO="sudo"
  fi

  echo "  ${GRAY}Installing package (may ask for your password)...${RESET}"
  if [ "$PKG" = "deb" ]; then
    # dpkg -i then apt-get -f is the idiomatic way to install a local .deb
    # with unmet runtime deps: apt resolves them from the configured repos.
    if ! $SUDO dpkg -i "$TMPD/$ASSET"; then
      $SUDO apt-get install -f -y \
        || die "Package installation failed." "Resolve the errors above, or install manually: $MANUAL_URL"
    fi
  else
    # shellcheck disable=SC2086  # RPM_INSTALL is a multi-word command prefix
    $SUDO $RPM_INSTALL "$TMPD/$ASSET" \
      || die "Package installation failed." "Resolve the errors above, or install manually: $MANUAL_URL"
  fi

  echo ""
  echo "  ${GREEN}Done! monkey-deck v$LATEST_VER installed.${RESET}"
  echo "  ${GRAY}Launch it from your application menu, or run: monkey-deck${RESET}"
  echo ""

else
  die "Unsupported OS: $OS" "monkey-deck ships macOS and Linux builds; Windows is not supported yet."
fi
