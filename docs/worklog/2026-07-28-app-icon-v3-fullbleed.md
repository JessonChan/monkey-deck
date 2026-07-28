# 应用图标换 v3：满版方形 + 去 AI 水印

## 起因

用户给了两张候选图标（`/tmp/monkey-deck-icon-{1,2}.png`，均 2048²，AI 生成、右下角带「豆包AI生成」水印），问哪张更符合 macOS app icon 规范，并要求：去水印 + full-bleed 处理 + 生成 iconset。

判定（上一轮已结论）：**icon-1 更合规**。icon-2 把「展示用浅灰背景 + 投影」烤成不透明像素且主体不满版，系统套蒙版会裁出一圈灰阴影边 + 双重投影，是规范反例；icon-1 无烤阴影、深色块接近满版。但 icon-1 仍自带圆角（透明角）+ 透明边距里的水印，需处理。

## 根因 / 规范

macOS Big Sur+ 对所有 app icon **强制**套超椭圆（squircle）蒙版 + 运行时投影，第三方无法 opt-out。由此源图必须满足：

1. **full-bleed 满版方形**——内容延伸到画布四角，不留边，系统蒙版裁出的圆角里全是你的内容。
2. **不自带圆角**——交给系统蒙版，自画会曲率打架 / 边缘露底。
3. **不自带阴影**——交给系统，自画 = 双重阴影。

实测 icon-1 的 alpha 形状：四角 alpha=0（透明），不透明主体 bbox ≈ `1907x1909+107+98`；水印字落在透明边距里，alpha 仅 0.01–0.10（主体 alpha≈0.996）。

## 改法

关键洞察：**水印在透明区** → 不需要 inpaint 猜色，只要把透明角填成不透明深色，水印即被覆盖；同时这一步把「自带圆角/透明边」变成「满版方形」，一举两得。

但「裁到主体 bbox」会留下黑色圆角缺口（squircle 的 bbox 角是透明的）→ 不合规。最终处理链（ImageMagick，本机无 PIL/numpy）：

1. 取不透明主体 bbox（`-alpha extract -threshold 50% -trim`，size 用 `%@`、origin 用 `%g` 的 offset 解析，避开 IM 的 `%+` 不支持坑）。
2. 裁满主体 → **alpha 硬化阈值 90%**（主体 0.996 保留；水印字 + 圆角抗锯齿 alpha 极低被剔除，水印在此步即消失）→ 在深色 `#182636` 上 flatten（填掉圆角缺口）→ `-resize 2048x2048!` 拉满（把略偏心的主体重新居中到真满版）。
3. 系统蒙版负责裁圆角 + 加投影，深色填充角落永不显示。

> 早期一版只裁 bbox 不填色 → 四角黑缺口；又一版 shell 解析把 crop 高度/偏移串错（`1907x1909+0+107+98`）→ 主体平移、左边露填充、水印残留。修正解析 + 90% 硬化后干净。

派生与生成（按 `docs/icon.md` 流程）：

- `sips -Z 1024 ... --out build/appicon.png`
- mac：`bash build/darwin/generate-icons.sh`（sips + iconutil，10 条 iconset）
- win：`magick build/appicon.png -define icon:auto-resize="256,128,64,48,32,16" build/windows/icon.ico`
- linux：`sips -Z 512 ... --out build/linux/icon.png`

## 改了哪些文件

- `assets/monkey-deck-icon-v3.png`（新增，处理好的 2048² 满版无水印设计源，入库）
- `build/appicon.png`（1024² 派生，覆盖）
- `build/darwin/icons.icns`（重生成，10 条）
- `build/windows/icon.ico`（重生成，6 帧）
- `build/linux/icon.png`（512²，此前未入库，本次纳入跟踪以与 mac/win 对齐）
- `docs/icon.md`（设计源章节 v2→v3；处理链由坏掉的 PIL/numpy 脚本改为 ImageMagick 满版+去水印链，并补 full-bleed/水印原理）
- 本工作日志

旧 `assets/monkey-deck-icon-v2*.png` 保留作历史迭代，未删（非本次范围）。

## 验证

- `sips`：v3 / appicon 均 `hasAlpha: no`，2048²/1024²。
- alpha 极值 `min=1 max=1`（全不透明，无透明角、无黑缺口）。
- 四角 = 深色填充 `srgb(24,38,54)`；四边中点 = 主体深色板（满版，蒙版边界落在主体上）。
- 水印区 0–255 灰度 max = **36**，与干净左下参考角、主体底边**完全相同** → 水印字彻底消失（早前 `max=0` 是 `round(maxima)` 把 0–1 量化塌缩的误报，已用 `255*maxima` 修正复核）。
- 目视 v3 与 `build/appicon.png`：猴子居中、满版深板、无水印、无缺口。
- mac icns 用 `iconutil -c iconset` 反向展开 = 恰好 10 条（`16x16`…`512x512@2x`），spot-check `@2x`=1024、`16x16`=16。
- win ico `magick identify` = 6 帧（16/32/48/64/128/256）。linux png = 512²。
- 无 Go/TS 代码改动，不影响 `go test`/前端构建（图标为纯资源）。

**未做（需 GUI / sudo，留给用户）**：未跑 `wails3 task package` 重打 .app，未执行 `docs/icon.md` 里的 `sudo rm -rf ...iconservices...` 清缓存——这两步要特权/会动系统缓存，按规矩不擅自动。

## 下一步

用户执行 `wails3 task package` + 清图标缓存（命令见 `docs/icon.md` §「macOS 图标缓存」）后 `open bin/monkey-deck.app`，目视确认 Dock / Launchpad / cmd-tab 显示新图标。若将来要 Big Sur 现代多层图标（dark/tinted/translucency），再走 `docs/icon.md` 末节的 Icon Composer 路径。
