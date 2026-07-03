# macOS 发布命名与打包规范化

**日期**:2026-07-02
**类型**:feat(release/macOS)

## 起因

项目准备发布到 macOS。审计发现命名、目录、打包、隐私声明、跨平台发布面多处不符合业界成熟 macOS 应用(Linear/Slack/VS Code/1Password)做法。用户要求:除 P0(签名+公证,需 Developer ID 证书,暂不做)外全部规范化;未发布无迁移/兼容包袱;用最成熟方案;不 build/test/commit,只改代码供 review。

## 改法

### 1. 数据目录按 macOS Library 语义分流(internal/config/config.go 重写)

引入应用身份常量 `AppName="Monkey Deck"` / `BundleID="com.jessonchan.monkeydeck"` / `AppSlug="monkey-deck"`,Config 拆为四个目录:

| 字段 | macOS 路径 | 性质 |
|---|---|---|
| DataDir | `~/Library/Application Support/Monkey Deck` | SQLite + 配置(不可丢) |
| LogsDir | `~/Library/Logs/Monkey Deck` | 诊断日志(Console.app 直接看) |
| CachesDir | `~/Library/Caches/com.jessonchan.monkeydeck` | worktree、pgid 跟踪(可再生) |
| StateDir | `~/Library/Saved Application State/com.jessonchan.monkeydeck.savedState` | 窗口几何 |

非 macOS 回退 XDG 子目录。新增 `TestConfig(dir)` 测试辅助(所有目录同落 dir)。

调用点 repoint:
- `main.go`:`monkey-deck.log` → `LogsDir`;`ui_state.json` → `StateDir`。
- `internal/chat/chat.go`:`harness-pgids.json` → `CachesDir`;`worktrees/` → `CachesDir/worktrees`;`GetConfig` 暴露全部目录。

测试全量切 `config.TestConfig`(integration/queue/scm×3/study/idle_reaper)。

### 2. Info.plist 补键(build/darwin/Info.plist + Info.dev.plist)

新增:`CFBundleDevelopmentRegion=zh-Hans`、`CFBundleDisplayName=Monkey Deck`、`CFBundleInfoDictionaryVersion=6.0`、`LSApplicationCategoryType=public.app-category.developer-tools`。

### 3. Privacy Manifest(build/darwin/PrivacyInfo.xcprivacy 新)

声明不跟踪、无采集、访问 API 类型(FileTimestamp C617.1 / DiskSpace E174.1 / SystemBootTime 35F9.1),打进 .app/Contents/Resources(prod + dev bundle 均含)。

### 4. .app 目录用显示名 + 可执行文件用 slug

根 Taskfile 新增 `BUNDLE_NAME="Monkey Deck"`(与 `APP_NAME="monkey-deck"` 分离)。`build/darwin/Taskfile.yml` 的 `create:app:bundle` / `codesign:adhoc` / `package` / `run` / `sign` / `sign:notarize` 全部改用 `{{.BUNDLE_NAME}}.app` 目录 + `{{.APP_NAME}}` 可执行文件;新增 `BUNDLE_SUFFIX` var 供 release 产 arch-suffixed app 目录(arm64/amd64 双架构不互相覆盖)。

### 5. 版本单一源 + plist 注入

release 流程用 PlistBuddy 把 `git describe` 注入到各架构 .app 的 `CFBundleShortVersionString`/`CFBundleVersion`(此前 plist 是硬编码 0.0.1)。`frontend/package.json` 版本 0.1.0 → 0.0.1 消除漂移。

### 6. DMG + universal release(Taskfile.yml 重写 release:darwin + 新增 darwin:dmg)

新 release 产出三件:universal DMG(`Monkey Deck <ver>-universal.dmg`,拖拽安装)+ arm64/amd64 updater zip(slug 命名,更新器依赖 darwin+arch 子串)+ 汇总 SHA256SUMS。`darwin:dmg` 用 lipo 合并双架构二进制 → create-dmg 打包(需 `brew install create-dmg`)。

### 7. 跨平台占位符清理

`build/windows/msix/app_manifest.xml` + `template.xml`:`com.example.testapp`/`My Product`/`My Company`/`testapp` → `com.jessonchan.monkeydeck`/`Monkey Deck`/`jessonchan`/`monkey-deck`。

## 改了哪些文件

### 跨平台目录分流(build tags 分发)
- `internal/config/config.go`(平台无关:Config struct、常量、Default()、EnsureDir、TestConfig)
- `internal/config/paths_darwin.go`(macOS:显示名 + BundleID)
- `internal/config/paths_unix.go`(Linux:kebab slug + StateHome)
- `internal/config/paths_windows.go`(Windows:%LOCALAPPDATA%\<App> 根 + 子目录)

### 调用点 + 打包面
- `main.go`(log → LogsDir、ui_state → StateDir、Name/Title 用 config.AppName、EnsureDir 不吞错误)
- `internal/chat/chat.go`(pgid/worktree → CachesDir、GetConfig 扩展)
- `build/darwin/Info.plist` + `Info.dev.plist`(补 4 键)
- `build/darwin/PrivacyInfo.xcprivacy`(新)
- `build/darwin/Taskfile.yml`(BUNDLE_NAME/BUNDLE_SUFFIX/PrivacyInfo 打包、sign:notarize 透传 suffix)
- `Taskfile.yml`(BUNDLE_NAME var、release:darwin 重写、darwin:dmg 新)
- `build/windows/msix/app_manifest.xml` + `template.xml`(占位符清理 + .exe + EntryPoint)
- `build/linux/desktop`(Categories=Development)
- `build/linux/nfpm/nfpm.yaml`(homepage 指向项目仓库)
- `frontend/package.json`(版本对齐 0.0.1)

### 测试
- `internal/config/config_test.go`(5 个通用用例)
- `internal/config/paths_{darwin,unix,windows}_test.go`(各平台命名约定断言)
- `internal/chat/worktree_path_test.go`(worktree 落 CachesDir 断言)
- `internal/chat/{integration,queue,scm,study,idle_reaper}_test.go`(切 TestConfig)

## 验证

- `go build . ./internal/...` 通过(darwin,仅 ld 版本警告)。
- 三平台交叉编译验证:`GOOS=linux go build`、`GOOS=windows go build` 均通过。
- ocr review 跑了两轮:第一轮采纳 3 条(MSIX .exe、sign BUNDLE_SUFFIX 透传、空行清理);第二轮采纳 3 条(MSIX EntryPoint、windows 注释措辞、EnsureDir 错误含目录上下文)。其余忽略(版本降级/空目录 log/TestConfig distinct 等无必要)。
- **未运行测试、未提交**(用户要求)。

## 下一步

- 用户 review 本批改动。
- P0(签名+公证)待 Developer ID 证书:新建 entitlements、codesign 加 `--options runtime`、release 接 sign:notarize + staple(必须在 zip 之前)。
- 图标:`build/appicon.png` 仍是默认链路,替换正式品牌图标后重新 `generate:icons`。
- 路径改动:`docs/worklog/README.md` 的路径约定、`AGENTS.md` §1.5/§1.6 的数据目录描述需同步更新(未改,避免夹带)。
