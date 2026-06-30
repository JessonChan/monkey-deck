> 最后维护：2026-06-30（新增 Windows/Linux 生成流程 + 源文件管理）
# 应用图标维护说明

> 解决「打包后 app 图标仍是 Wails 默认 W」的问题，并记录以后换图标的正确流程。

## 图标从哪来

macOS app 图标的实际来源链：

```
build/appicon.png  ──wails3 generate icons──▶  build/darwin/icons.icns
              （build/Taskfile.yml: generate:icons）          │
                                                                ▼
                                              bin/monkey-deck.app/Contents/Resources/icons.icns
                                                                │
                                              Info.plist: CFBundleIconFile = icons
                                                                ▼
                                                    macOS Dock / Launchpad / cmd-tab
```

**唯一真相来源 = `build/appicon.png`。改它即可。**

## 如何换图标

1. 用新图标覆盖 `build/appicon.png`（PNG，建议 ≥1024×1024，正方形）。
2. 重新打包：`wails3 task package`
3. 清 macOS 图标缓存（**必做，见下**）。
4. `open bin/monkey-deck.app` 验证。

## ⚠️ macOS 图标缓存（换图标后必清）

bundle id (`com.jessonchan.monkeydeck`) 不变时，LaunchServices / iconservices 会**沿用旧图标缓存**——资源换了但 Dock / Launchpad 仍显示旧图。非特权手段（`lsregister`、`killall Dock`）清不掉系统级缓存。

每次换图标后跑：

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
| `build/appicon.png` | **图标唯一源**（换图标改这个） |
| `build/appicon.icon/` | Icon Composer 项目（当前未启用，内含默认 W，保留备用） |
| `build/darwin/icons.icns` | 由 appicon.png 生成，打入 app bundle |
| `build/darwin/Assets.car` | 已删除（内含默认 W）；启用现代图标时重生 |
| `build/darwin/Info.plist` / `Info.dev.plist` | `CFBundleIconFile = icons` |
| `build/Taskfile.yml` | `generate:icons` task 定义 |
> —— macOS Dock / Launchpad / cmd-tab

## 图标设计源文件（真相之上）

`build/appicon.png` 自动生成自以下设计源文件之一：

```
monkey-deck-icon-v2.png          ← 设计师交付的 2048×2048 主图（完整含透明 padding）
monkey-deck-icon-v2-cropped.png  ← 最终扣好的 1062×1062 1:1 内容（去掉羽化白边）
```

设计源文件放在项目根目录，不入库（`.gitignore` 排除构建产物，但 git 跟踪根目录 PNG）。

**从设计稿到 `build/appicon.png` 的处理链**：

```bash
# 1. 拿到设计稿（2048×2048，alpha>0 含羽化边距）
# 2. 扣掉羽化白边，保留 1:1 核心主体
python3 -c "
from PIL import Image; import numpy as np
img = Image.open('monkey-deck-icon-v2.png').convert('RGBA')
a = np.array(img)[:,:,3]
ys, xs = np.where(a >= 180)  # 实色核心，避开低 alpha 羽化
img.crop((xs.min(), ys.min(), xs.max()+1, ys.max()+1)) \
   .save('monkey-deck-icon-v2-cropped.png', 'PNG')
"
# 3. 等比缩放到 1024×1024
sips -Z 1024 monkey-deck-icon-v2-cropped.png --out build/appicon.png
```

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
| macOS | `build/darwin/icons.icns` | ICNS | 16~512 @1x/@2x | `iconutil -c icns appicon.iconset` |
| Windows | `build/windows/icon.ico` | ICO | 16~256 多帧 | `magick` 或多帧 PIL 脚本 |
| 通用源 | `build/appicon.png` | PNG | 1024×1024 | 从裁剪图缩放 |
| Linux | `build/linux/icon.png` | PNG | 512×512 | `sips -Z 512` |

改图标后四个文件都要重生成。
