> 最后维护：2026-07-28（应用图标换 v3 满版无水印稿；设计源处理链改用 ImageMagick 满版 + 去水印）
# 应用图标维护说明

> 解决「打包后 app 图标仍是 Wails 默认 W」的问题，并记录以后换图标的正确流程。

## 图标从哪来

macOS app 图标的实际来源链：

```
build/appicon.png  ──wails3 generate icons + build/darwin/generate-icons.sh──▶  build/darwin/icons.icns
               （build/Taskfile.yml: generate:icons）          │
                                                                 ▼
                                               bin/monkey-deck.app/Contents/Resources/icons.icns
                                                                 │
                                               Info.plist: CFBundleIconFile = icons
                                                                 ▼
                                                     macOS Dock / Launchpad / cmd-tab
```

**唯一真相来源 = `build/appicon.png`。改它即可。**

> macOS icns 生成:`wails3 generate icons` 产出的 icns 缺 `icon_16x16.png`/`icon_32x32.png`(@1x),只有 8/10 条目。故 `generate:icons` 在 wails3 之后追加 `build/darwin/generate-icons.sh`(sips + `iconutil -c icns`)重生成完整 10 条 iconset(含 1024x1024)。手动重生成:`make icons` 或 `bash build/darwin/generate-icons.sh`。

## 如何换图标

1. 用新图标覆盖 `build/appicon.png`（PNG，建议 ≥1024×1024，正方形）。
2. 重新打包：`wails3 task darwin:package`（= build + create:app:bundle，后者把 `build/darwin/icons.icns` cp 进 `.app`）。
   > ⚠️ `wails3 build` / `wails3 task darwin:build` **只编译裸二进制**，不碰 `.app` bundle。必须跑 `package` 才会更新 bundle 里的 icns。
3. 清 macOS 图标缓存（**必做，见下**）。
4. `open "bin/Monkey Deck.app"` 验证。

> ⚠️ **bundle 名陷阱**：`.app` 目录名 = `config.yml` 的 `productName`（当前 = `Monkey Deck`），所以正确路径是 `bin/Monkey Deck.app`（注意空格）。`bin/monkey-deck.app` 是历史残留的 **decoy**——构建系统不再更新它，打开它永远看到旧图标。同理 `bin/monkey-deck.dev.app` 也是 decoy；dev 模式的 bundle 叫 `bin/Monkey Deck.dev.app`。

## ⚠️ macOS 图标缓存（换图标后必清）

bundle id (`com.jessonchan.monkeydeck`) 不变时，LaunchServices / iconservices 会**沿用旧图标缓存**——资源换了但 Dock / Launchpad 仍显示旧图。

**非 sudo 手段**（通常够用）：

```bash
rm -rf ~/Library/Caches/com.apple.iconservices.store
# 强制 LaunchServices 重新索引
for d in bin/*.app; do
  touch "$d"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$d"
done
killall Dock Finder
```

**sudo 手段**（非 sudo 无效时）：

```bash
sudo rm -rf /Library/Caches/com.apple.iconservices.store ~/Library/Caches/com.apple.iconservices.store
sudo find /private/var/folders/ -name com.apple.iconservices -exec rm -rf {} + 2>/dev/null
sudo find /private/var/folders/ -name com.apple.dock.iconcache -exec rm -f {} + 2>/dev/null
killall Dock Finder
```

核武器（会重置 Launchpad 布局，仅当上面无效再用）：

```bash
defaults write com.apple.dock ResetLaunchPad -bool true && killall Dock
```

## 为什么不用 Icon Composer / Assets.car（踩坑记录）

Wails3 脚手架默认的 `generate:icons` 带这两个参数：

```
-iconcomposerinput appicon.icon -macassetdir darwin
```

这会让 Wails **完全用 `build/appicon.icon`（Apple Icon Composer 项目）生成 icns + Assets.car，忽略 `appicon.png`**。而脚手架自带的 `appicon.icon/icon.json` 引用的是 `wails_icon_vector.svg`（Wails 默认 W），再加上：

- macOS Big Sur+ **优先用 `Assets.car` 里 `CFBundleIconName` 指向的图标**，而不是 `icons.icns`。

两者叠加 → 你换 `appicon.png` 完全无效，图标永远是默认 W。

本项目已做的修复（2026-06-28）：

1. `build/Taskfile.yml` 的 `generate:icons` 去掉 `-iconcomposerinput` / `-macassetdir`，改为纯 `appicon.png → icons.icns`。
2. 删除 `build/darwin/Assets.car`（内含默认 W）。
3. `build/darwin/Info.plist`、`Info.dev.plist` 删除 `CFBundleIconName=appicon`，只留 `CFBundleIconFile=icons`，强制 macOS 使用 icns。

## 将来想要 macOS 现代图标（深色 / 着色 / 半透明多层）

当前方案是「单张 PNG 走 icns」，不支持 Big Sur+ 的现代图标特性（dark / tinted / translucency）。若将来需要：

1. 用 Xcode **Icon Composer** 打开 `build/appicon.icon`，把里面的 `wails_icon_vector.svg` 换成你的矢量 artwork，配置各 appearance。
2. 在 `build/Taskfile.yml` 的 `generate:icons` 里重新加回：
   ```
   -iconcomposerinput appicon.icon -macassetdir darwin
   ```
3. 在 `build/darwin/Info.plist` / `Info.dev.plist` 加回：
   ```xml
   <key>CFBundleIconName</key>
   <string>appicon</string>
   ```
4. `wails3 task package` + 清缓存。

## 相关文件清单

| 文件 | 作用 |
|---|---|
| `build/appicon.png` | **图标唯一源**(换图标改这个) |
| `build/appicon.icon/` | Icon Composer 项目(当前未启用,内含默认 W,保留备用) |
| `build/darwin/generate-icons.sh` | 从 appicon.png 生成完整 iconset + icons.icns(sips + iconutil) |
| `build/darwin/icons.icns` | 由 generate-icons.sh 生成(10 条 iconset,含 1024x1024),打入 app bundle |
| `build/darwin/Assets.car` | 已删除(内含默认 W);启用现代图标时重生 |
| `build/darwin/Info.plist` / `Info.dev.plist` | `CFBundleIconFile = icons` |
| `build/Taskfile.yml` | `generate:icons` task 定义 |
> —— macOS Dock / Launchpad / cmd-tab

## 图标设计源文件（真相之上）

`build/appicon.png` 由当前设计源 `assets/monkey-deck-icon-v3.png`（2048×2048，满版方形）派生。

设计源文件放在 `assets/`（git 跟踪，入库）。历史迭代 `monkey-deck-icon-v2*.png` 保留备查，已不再是源。

**为什么 v3 是「满版方形」（full-bleed：无圆角 / 无透明边 / 无自带阴影）**：macOS Big Sur+ 对所有 app icon 强制套超椭圆（squircle）蒙版 + 运行时投影，源图必须满版方形——圆角与投影交给系统。若源图自带圆角或透明 padding，系统蒙版裁切会露底 / 裁到透明边 / 与系统圆角曲率打架。故 v3 把不透明主体裁满整个画布，透明角填成同色深色板（`#182636`，落在系统蒙版之外，不显示）。

**附带去除 AI 生成水印**：原稿右下角「豆包AI生成」水印落在透明边距里（alpha≈0）。裁满版 + alpha 硬化（阈值 90%：主体 alpha≈0.996 保留，水印字与圆角抗锯齿 alpha 极低被剔除）后，水印随透明区一起消失，无需 inpaint 猜色。

**从原稿到 `build/appicon.png` 的处理链**（ImageMagick；本机无 PIL/numpy，故弃用旧 PIL 脚本）：

```bash
SRC=<带透明边/水印的原稿.png>
DARK="#182636"
# 1. 取不透明主体 bbox（裁掉透明 padding 与边距里的水印）
sz=$(magick $SRC -alpha extract -threshold 50% -trim -format '%@' info:)   # WxH+0+0
pg=$(magick $SRC -alpha extract -threshold 50% -trim -format '%g' info:)   # PAGEw x PAGEh +X +Y
trim=${sz%%+*}; W=${trim%x*}; H=${trim#*x}
off=${pg#*+}; X=${off%+*}; Y=${off#*+}
# 2. 裁满主体 → alpha 硬化(90%)去水印/抗锯齿 → 填深色去圆角缺口 → 拉满 2048
magick $SRC -crop ${W}x${H}+${X}+${Y} +repage \
  \( +clone -alpha extract -threshold 90% \) -compose CopyOpacity -composite \
  -background $DARK -alpha remove -alpha off -resize 2048x2048! \
  assets/monkey-deck-icon-v3.png
# 3. 派生 1024 通用源
sips -Z 1024 assets/monkey-deck-icon-v3.png --out build/appicon.png
```

> `assets/monkey-deck-icon-v3.png` 已是处理好的满版结果，日常换图标直接覆盖 `build/appicon.png` 或重跑第 3 步即可；上面 1–2 步仅在拿到「带透明边 / 水印」的新原稿时才需要。

## Windows / Linux 图标生成

`wails3 task package` 只打 macOS .app，Windows/Linux 图标不会自动重生成。手动跑：

```bash
# —— Windows ICO（32-bit RGBA，多尺寸） ——
mkdir build/appicon.iconset

# 生成 6 标准尺寸 PNG
for s in 16 32 48 64 128 256; do
  sips -z $s $s build/appicon.png --out build/appicon.iconset/icon_${s}x${s}.png
done

# 组装多帧 ICO（PIL 多帧 ICO 有 bug，用 imagemagick）
magick build/appicon.png -define icon:auto-resize="256,128,64,48,32,16" \
  build/windows/icon.ico

# —— Linux AppImage / PNG 图标 ——
sips -Z 512 build/appicon.png --out build/linux/icon.png   # AppImage 用
```

或者全用 Python：

```bash
python3 << 'EOF'
from PIL import Image; import struct, io
img = Image.open('build/appicon.png').convert('RGBA')
sizes = [16, 32, 48, 64, 128, 256]
frames = []
for s in sizes:
    buf = io.BytesIO()
    img.resize((s,s), Image.LANCZOS).save(buf, 'PNG')
    frames.append(buf.getvalue())
header = struct.pack('<HHH', 0, 1, len(frames))
dir_ = b''; offset = 6 + len(frames)*16
for i,s in enumerate(sizes):
    w = 0 if s>=256 else s
    dir_ += struct.pack('<BBBBHHII', w, w, 0, 0, 1, 32, len(frames[i]), offset)
    offset += len(frames[i])
with open('build/windows/icon.ico','wb') as f:
    f.write(header + dir_ + b''.join(frames))
EOF
```

> ICO 多帧结构：256px 在 ICO header 里宽度/高度字节写 0（代表 256）。各帧 PNG 独立编码，Explorer 按显示尺寸挑合适帧。

## 各端图标清单

| 平台 | 文件 | 格式 | 尺寸 | 生成方式 |
|---|---|---|---|---|
| macOS | `build/darwin/icons.icns` | ICNS | 16~512 @1x/@2x(含 1024) | `bash build/darwin/generate-icons.sh`(sips + iconutil) |
| Windows | `build/windows/icon.ico` | ICO | 16~256 多帧 | `magick` 或多帧 PIL 脚本 |
| 通用源 | `build/appicon.png` | PNG | 1024×1024 | 从裁剪图缩放 |
| Linux | `build/linux/icon.png` | PNG | 512×512 | `sips -Z 512` |

改图标后四个文件都要重生成。
