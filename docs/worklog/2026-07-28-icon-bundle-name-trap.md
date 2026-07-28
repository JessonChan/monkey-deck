# 换图标后 .app 不更新：bundle 名陷阱 + build vs package

## 起因

用户按 `docs/icon.md` 流程换完图标后跑 `wails3 task package` + `open bin/monkey-deck.app`，仍看到旧图标。

## 根因

**两个独立问题叠加**：

1. **`bin/monkey-deck.app` 是 decoy**：Wails3 的 `create:app:bundle` 用 `config.yml` 的 `productName`（= `Monkey Deck`）作为 bundle 目录名，产出 `bin/Monkey Deck.app`。而 `bin/monkey-deck.app` 是早期（productName 还是 slug 时）残留的旧 bundle，构建系统**不再更新它**。用户一直 `open` 这个 decoy → 永远旧图标。

2. **`wails3 build` ≠ `wails3 task package`**：`build` 只编译裸二进制 `bin/monkey-deck`，不碰任何 `.app`。只有 `package`（= `build` + `create:app:bundle`）才会 `cp build/darwin/icons.icns` 进 bundle 的 `Contents/Resources/`。如果用户跑的是 `wails3 build`（或 package 在前端/编译阶段报错没走到 bundle 步），.app 里的 icns 就不会被刷新。

## 修复

1. **手动同步**：把 `build/darwin/icons.icns`（新猴子 md5 `095506…`）cp 进 `bin/` 下所有 4 个 `.app` 的 `Contents/Resources/`，消除 decoy 歧义。
2. **清 icon cache**：`rm -rf ~/Library/Caches/com.apple.iconservices.store` + `touch` 所有 `.app` + `lsregister -f` 强制重索引 + `killall Dock Finder`。
3. **修正 `docs/icon.md`**：
   - 步骤 2 改为 `wails3 task darwin:package`，加注释说明 `build` 不碰 bundle。
   - 步骤 4 改为 `open "bin/Monkey Deck.app"`。
   - 新增「bundle 名陷阱」警告段落。
   - 新增非 sudo 清缓存手段（`lsregister -f` + `touch` + `killall`），sudo 降为备选。

## 改了哪些文件

- `docs/icon.md`（修正路径 + 补陷阱说明 + 非 sudo 清缓存）
- `bin/*.app/Contents/Resources/icons.icns`（4 个 bundle 全部同步为新 icns；bin/ 在 .gitignore 里，不入库）
- 本工作日志

## 验证

- 4 个 bundle 的 icns md5 全部 = `0955065c96e90613b97eea572dd35497`（= `build/darwin/icons.icns`）。
- icon cache 已清 + Dock/Finder 已重启。
- 用户执行 `open "bin/Monkey Deck.app"` 应看到新猴子。

## 下一步

无。若用户仍看不到新图标（极端缓存情况），跑 `docs/icon.md` 里的 sudo 清缓存或核武器 `defaults write com.apple.dock ResetLaunchPad -bool true && killall Dock`。
