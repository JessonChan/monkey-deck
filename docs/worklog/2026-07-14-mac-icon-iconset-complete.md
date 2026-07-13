# 2026-07-14 修复 mac 应用图标:补全 iconset 至完整 10 尺寸(含 1024x1024)

## 起因
Task #14770:mac 应用图标偏小、不符 macOS 规范。要求检查 build/darwin/ 图标资源,确保 iconset 完整(16/32/128/256/512 的 @1x/@2x 全尺寸,尤其含 1024x1024),并修正构建配置。

## 根因(定位)
把 `build/darwin/icons.icns` 解包成 iconset 逐张量像素:
- 原文件只有 **8/10 条目**,缺 `icon_16x16.png`(16) 和 `icon_32x32.png`(32) 两个 @1x。
- 1024x1024 其实**存在**(`icon_512x512@2x.png`,1024×1024),源图 `build/appicon.png` 也是 1024×1024,设计源 `assets/monkey-deck-icon-v2.png` 是 2048×2048——源分辨率足够。
- 缺的是 @1x 小尺寸,根因在生成器:`build/Taskfile.yml` 的 `generate:icons` 用 `wails3 generate icons` 生成 icns,该工具产出的 iconset 不含 `icon_16x16`/`icon_32x16` @1x 条目,不是 Apple 规范的完整 10 条。
- 构建配置引用**正确**:`Info.plist` 的 `CFBundleIconFile=icons`,`create:app:bundle` 拷 `build/darwin/icons.icns` 进 Resources——链路无误,无需改。

> 注:用户感知的「偏小」若是图标 artwork 本身 padding 过大(主体在画布内占比小),属设计层,本任务范围是 iconset 规格/构建配置,不涉及重绘(裁剪源 `assets/monkey-deck-icon-v2-cropped.png` 已处理羽化边距)。

## 改法
用 Apple 原生 `sips` + `iconutil -c icns` 生成完整 10 条 iconset(`docs/icon.md` 本就记录这是 mac 图标正确生成方式),取代 wails3 对 mac icns 的权威性:

1. 新增 `build/darwin/generate-icons.sh`:从 `build/appicon.png`(校验 ≥1024)生成 10 张标准命名 PNG,`iconutil` 打包成 `build/darwin/icons.icns`。可复现,带尺寸校验与依赖检查。
2. `build/Taskfile.yml` 的 `generate:icons`:wails3 仍负责 windows/icon.ico(及一份 mac icns),随后追加 `bash darwin/generate-icons.sh` 覆盖出完整 mac icns。summary 注释更新。
3. `Makefile`:新增 `icons` target(`bash build/darwin/generate-icons.sh`)。
4. 立即重生成 `build/darwin/icons.icns`(现 10 条,含 1024x1024)。
5. `docs/icon.md`:更新生成链路图、文件清单、各端图标清单,指向新脚本。

## 改了哪些文件
- `build/darwin/generate-icons.sh`(新增)
- `build/darwin/icons.icns`(重生成,8→10 条目)
- `build/Taskfile.yml`(`generate:icons` 追加 iconutil 步骤 + summary)
- `Makefile`(新增 `icons` target)
- `docs/icon.md`(文档同步)

## 验证
- 解包新 icns:`iconutil -c iconset` 得 **10** 个 PNG,尺寸 16/32/64/128/256/512/1024 全对,`icon_512x512@2x` = 1024×1024 ✓。
- acceptance gate:`go build ./...` / `go vet ./...` / `go test ./...` 全过(test 全 ok;ld 的 macOS 版本 warning 与本改动无关,是 SDK 提示)。
- dist stub:为 `//go:embed all:frontend/dist` 造了 `frontend/dist/index.html` 临时桩(`frontend/dist/` 在 .gitignore,不入库)。

## 下一步
- 真机验证:`make app` 打包后清 macOS 图标缓存(`docs/icon.md` 「macOS 图标缓存」一节),看 Dock/Launchpad 显示。
- 若仍觉 artwork 偏小,再评估是否调整 `assets/` 设计源的 padding 重扣图(设计层,非本任务)。
