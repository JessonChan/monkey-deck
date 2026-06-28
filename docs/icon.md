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
