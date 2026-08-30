# 2026-08-30 fix-plist-injection-before-codesign

## 起因

分析 EchoBird 的 `curl | sh` 分发方案(echobird.ai/install.sh,见同日调研)评估我们能否采用同款 Mac 分发时,顺藤摸出 **release 管线一个真实的 seal 破坏 bug**:Info.plist 版本注入发生在 ad-hoc 签名**之后**,导致发布的 zip 资产里的 .app bundle seal 是破的。

## 根因

- `Taskfile.yml` 的 `release:darwin` 原顺序:
  1. `darwin:package` → `create:app:bundle` → `codesign:adhoc`(**先签名**)
  2. PlistBuddy 改 `CFBundleShortVersionString`/`CFBundleVersion`(**后改 plist**)
  3. `zip` 资产(**破 seal 状态被固化进发布物**)
- Info.plist 是 bundle 签名的 sealed resources 的一部分。签名后再改,`codesign --verify --deep --strict` 即失败:`invalid Info.plist (plist or signature have been modified)`(本地最小 bundle 复现实锤)。
- 今天没炸的原因:ad-hoc + 无 quarantine 场景下,kernel 只验主二进制 cdhash(未被 PlistBuddy 碰过,有效),没人验 bundle seal。但这是踩在边缘上;且:
  - `darwin:sign` / `darwin:sign:notarize`(Developer ID 路线)对破 seal bundle 会被公证 API 直接拒;
  - 任何用户/工具跑 `codesign --verify` 都能看到 bundle 是"被篡改"状态。

## 修法

把注入挪到签名之前,删除后置注入块:

- `build/darwin/Taskfile.yml` `create:app:bundle`:cp 完 Info.plist 后、`codesign:adhoc` 前,用 PlistBuddy 注入 `{{.VERSION}}`(即 `git describe` 结果)到两个版本键。PlistBuddy 不存在时(cross-compile)no-op——bundle 反正要在 mac 上重签。
- `Taskfile.yml` `release:darwin`:删除原"1) 注入 git tag 版本"整块(注入已上移),重排注释编号。

版本单一源不变:仍是 `git describe --tags --always --dirty`。DMG 路径不受影响(`darwin:dmg` lipo 后重签,plist 从 arm64 .app 继承)。

## 改了哪些文件

- `build/darwin/Taskfile.yml`(create:app:bundle 内加注入,签名前)
- `Taskfile.yml`(release:darwin 删后置注入块)

## 验证

- 机制复现:最小合成 bundle "签名→改 plist" → `codesign --verify` 报 `invalid Info.plist`(确认根因)。
- 真实构建:`wails3 task darwin:package ARCH=arm64/amd64 BUNDLE_SUFFIX=-arm64/-amd64` 各跑一次:
  - `codesign --verify --deep --strict` 两个架构均 OK(seal 完整);
  - `plutil -extract` 确认 plist 两键 = `862c463-dirty`(与 git describe 一致)。
- updater 链路模拟(假二进制 app,不启动真 app):按 release 流程 zip → ditto 解压到 staging → 验 seal OK → 模拟 wails helper 精确 swap(backup → RemoveAll → Rename → `open -n`)→ **swap 后 seal OK、版本已换新、无 quarantine、launch 成功**。
- `go test ./internal/update/` 通过。
- 注意坑:`defaults read <bundle>/Contents/Info` 走 cfprefd 缓存,对刚构建的 .app 可能报键不存在(假阴性);验 plist 一律用 `plutil`/`PlistBuddy`。将来 install.sh 读已装版本也必须用 `plutil`,不能用 `defaults`。

## 下一步

- install.sh 分发脚本本体(骨架已调研:EchoBird 模式 = curl 下载不写 quarantine + `xattr -dr com.apple.quarantine` 剥离,ad-hoc 签名即可,无需 Developer ID/公证)。前提:修完本 bug(已修)。
- README 加 `curl | sh` 安装行(等 install.sh 落地)。
- 知情确认:ad-hoc 每次构建 cdhash 变 → TCC 权限(如访问 ~/Documents)每次升级重弹;上 Developer ID 可消除。
