#!/usr/bin/env bash
# 从 build/appicon.png 生成符合 Apple 规范的完整 iconset 并打包成 icons.icns。
#
# 解决问题:wails3 generate icons 产出的 icns 缺 icon_16x16.png / icon_32x32.png
# (@1x),只有 8/10 条目。本脚本用 sips + iconutil 生成全尺寸(含 1024x1024,
# 即 icon_512x512@2x),是 macOS 图标的权威生成方式(见 docs/icon.md)。
#
# 用法:bash build/darwin/generate-icons.sh [appicon.png]
# 依赖:macOS 自带 sips / iconutil(仅 macOS 可用,与 build/darwin/ 定位一致)。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC="${1:-$ROOT_DIR/build/appicon.png}"
OUT_ICNS="$SCRIPT_DIR/icons.icns"

if [[ ! -f "$SRC" ]]; then
  echo "error: source icon not found: $SRC" >&2
  exit 1
fi

if ! command -v iconutil >/dev/null 2>&1 || ! command -v sips >/dev/null 2>&1; then
  echo "error: sips/iconutil not found (macOS only)." >&2
  exit 1
fi

# 校验源图尺寸 >=1024(不足 1024 放大到 1024 会糊,直接报错让换源)。
SRC_W=$(sips -g pixelWidth "$SRC" | awk '/pixelWidth/{print $2}')
SRC_H=$(sips -g pixelHeight "$SRC" | awk '/pixelHeight/{print $2}')
if [[ "$SRC_W" -lt 1024 || "$SRC_H" -lt 1024 ]]; then
  echo "error: source must be >=1024x1024 (got ${SRC_W}x${SRC_H}): $SRC" >&2
  echo "       drop a larger PNG at build/appicon.png (设计源 assets/ 有 2048x2048)." >&2
  exit 1
fi

WORK="$(mktemp -d)/appicon.iconset"
trap 'rm -rf "$(dirname "$WORK")"' EXIT
mkdir -p "$WORK"

# Apple iconset 规范:16/32/128/256/512 的 @1x 与 @2x,共 10 张。
# 命名必须严格匹配 iconutil 约定,否则报错。@2x 像素 = @1x × 2。
gen() {
  local base="$1" px="$2"
  sips -z "$px" "$px" "$SRC" --out "$WORK/icon_${base}.png" >/dev/null
}
gen "16x16"     16
gen "16x16@2x"  32
gen "32x32"     32
gen "32x32@2x"  64
gen "128x128"   128
gen "128x128@2x" 256
gen "256x256"   256
gen "256x256@2x" 512
gen "512x512"   512
gen "512x512@2x" 1024

iconutil -c icns -o "$OUT_ICNS" "$WORK"
echo "generated: $OUT_ICNS (10 sizes, incl. 1024x1024) from $SRC"
