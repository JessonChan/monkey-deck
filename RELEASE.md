# 应用升级与发布指引

> 本文件说明 **monkey-deck 如何自我升级**(用户视角)以及 **如何发布一个可被升级的新版本**(发布者视角)。
> 实现代码在 [`internal/update/`](./internal/update/update.go);进度/决策见 [PROCESS.md](./PROCESS.md) §G(2026-06-29 auto-update)。

---

## 1. 工作原理(一句话)

应用通过 **Wails3 内置的 `app.Updater`** 从 **GitHub Releases** 拉取新版本,校验 SHA256 后用 **helper-mode 热替换正在运行的二进制并重启** —— 全程不依赖外部 helper 可执行文件,也不走非 ACP 通道(与 agent 交互无关,纯属桌面应用自更新)。

完整流程:

```
检查(latest release) → semver 比较(是否更新)
  → 下载对应平台 asset → 用 SHA256SUMS 校验
  → 暂存到临时目录 → 用户点「重启并应用」
  → spawn helper-mode 子进程(同二进制 + 哨兵环境变量)
  → 主进程退出 → helper 替换二进制 → 重新拉起新版本
```

---

## 2. 用户视角:检查并安装更新

| 入口 | 行为 |
|---|---|
| **菜单「Monkey Deck → 检查更新…」** | 打开内置更新窗口,走完整流程(检查→下载→校验→重启);「已是最新」也会停留显示,手动关闭。 |
| **后台静默检查(仅发布版)** | 应用启动 30s 后,每 **6 小时**静默检查一次;**只有发现新版本才弹窗**,「已是最新」不打扰。 |

> 开发构建(`currentVersion == "dev"`)**不会**后台自动检查 —— 见 §4 为什么。

窗口里的「重启并应用」会退出当前应用、替换二进制、重新启动。会话数据都在本地 SQLite,重启不丢失。

---

## 3. 发布者视角:发布一个新版本

三步:**打 tag → 打包 → 发 GitHub Release**。关键是 **先打 tag 再 build**(版本号由 git tag 注入)。

### 3.1 打 tag(确保工作区干净)

```bash
git checkout main
git pull
git status          # 必须干净,否则 git describe 会带 -dirty
git tag v0.1.0
```

> tag 必须是 `v` 开头的语义化版本(`v0.1.0`、`v1.2.3`)。

### 3.2 构建并打包

```bash
wails3 task release:darwin
```

该任务依次:`darwin:package`(编译 + 打 .app + ad-hoc 签名)→ zip 成 `bin/monkey-deck-darwin-<arch>.zip`(`-y` 保留 .app 内符号链接)→ 生成 `bin/SHA256SUMS` → 打印一条可直接复制的 `gh release create` 命令。

- 默认打**当前架构**(Apple Silicon 上是 `arm64`)。
- 指定架构:`wails3 task release:darwin ARCH=amd64`。
- 二进制内的 `currentVersion` 在此步由 git tag 经 ldflags 注入(见 §4)。

### 3.3 发到 GitHub Release

用上一步打印的命令,或手动(注意 **zip 与 SHA256SUMS 必须同一次上传**):

```bash
gh release create v0.1.0 \
  bin/SHA256SUMS \
  bin/monkey-deck-darwin-arm64.zip \
  --title "v0.1.0" \
  --generate-notes
```

发布后,**旧版本**启动(或后台检查)就会看到这个新 release → 弹窗 → 下载校验 → 重启升级。

> **资源命名硬约束**:文件名必须含 `darwin` 与 `arm64`/`amd64`,否则更新器匹配不到当前平台 asset(`DefaultAssetMatcher` 按 `GOOS`+`GOARCH` 子串匹配)。`release:darwin` 产出的命名已满足。

---

## 4. 版本号机制(为什么先 tag 再 build)

| 来源 | 值 | 说明 |
|---|---|---|
| 运行时 `main.currentVersion` | 发布时由 `-ldflags -X main.currentVersion=...` 注入 | 见 `build/darwin/Taskfile.yml` 的 `VERSION` |
| `VERSION` 计算式 | `git describe --tags --always --dirty \| sed 's/^v//'` | tag `v0.1.0` → `0.1.0`;无 tag → 短 commit hash;非 git 仓库 → `dev` |
| 开发构建(`wails3 task dev` / DEV 分支) | `"dev"` | DEV 分支不注入版本,`currentVersion` 取源码默认值 `"dev"` |

**为什么 `dev` 要禁用后台检查**:更新器用 [semver](https://pkg.go.dev/golang.org/x/mod/semver) 比较;`"dev"` 是非法 semver,会被判定为**低于任何正式版**,于是把首个 release 误判成「有更新」并在后台循环里反复弹窗。`update.ShouldAutoCheck("dev") == false` 据此关掉后台检查(菜单手动检查仍可用)。

**版本一致性**:release tag = `v0.1.0`,二进制内 `currentVersion` = `0.1.0`(去前导 `v`)。升级并重启后,新版本检查同一 tag → semver 相等 →「已是最新」,闭环。

---

## 5. 配置项(都在 `internal/update/update.go`)

| 常量 | 当前值 | 改动场景 |
|---|---|---|
| `GitHubRepository` | `jessonchan/monkey-deck` | 换发布仓库(owner/repo) |
| `ChecksumAsset` | `SHA256SUMS` | 换校验文件名 |
| `BackgroundInterval` | `6h` | 调后台检查频率 |

私有仓库:在 `newProvider()` 的 `github.Config` 加 `Token: "ghp_..."`(PAT,`public_repo` / `repo` scope);公共仓库无需 token(60 req/h,加 token 提到 5000)。

GitHub Enterprise:加 `BaseURL: "https://<host>/api/v3"`。

---

## 6. 首次启用前置(当前未满足,见 PROCESS.md §F)

仓库当前**无 git remote、无 tag**。要让自更新真正生效:

1. 创建并 push GitHub 仓库 `jessonchan/monkey-deck`(与 go.mod module 路径一致)。
2. 按 §3 发**首个 release**。
3. 此后任意旧版本启动即可检查/升级。

代码侧已就绪,只是还没有可拉的 release。

---

## 7. 故障排查

| 现象 | 原因 / 修法 |
|---|---|
| 窗口报 404 | `GitHubRepository` 写错 / 仓库不存在或未公开 |
| 窗口报 403 rate-limited | GitHub API 限流;加 `Token`(PAT) |
| `release has no asset for darwin/arm64` | 资源名不含 `darwin`+架构;检查 §3 命名 |
| 下载后校验失败 | `SHA256SUMS` 与 zip 不是同一次 release / 内容对不上;**两者必须一起上传** |
| 升级后版本号没变 | 发布时没先 `git tag` 就 build → 注入的是旧/commit 版本;见 §4 |
| macOS 提示「无法打开」/ Gatekeeper 拦截 | .app 未签名公证;见 §8 |

---

## 8. 分发签名(生产环境必读)

更新器**原样替换字节,不重新签名**。macOS Gatekeeper 要求替换后的二进制仍是已签名+公证的,因此:

- 发布前对 `.app` 做 **Developer ID 签名 + 公证**(`wails3 task darwin:sign:notarize`,需 `wails3 setup` 配置签名身份与 keychain profile),**再** zip 上传。
- Windows 同理需 Authenticode 签名,否则触发 SmartScreen。

当前 `release:darwin` 走的是 **ad-hoc 签名**(`codesign --sign -`,仅本地可用,**过不了 Gatekeeper**)。面向外部用户分发前必须替换为正式签名步骤。

---

## 9. 后续可选增强

- **设置 UI**:把「当前版本 / 检查更新」接进未来的设置页(现仅菜单;加一个 Wails binding 调 `app.Updater.CheckAndInstall` 即可)。
- **Ed25519 签名**:超越 SHA256 的完整性,做**真实性**校验(防 release 账号被攻破)。embed 公钥 → `updater.Config.PublicKey`。
- **Universal Binary**:同时发 `arm64`+`amd64`(`wails3 task darwin:build:universal`),一个 zip 覆盖所有 Mac。
- **自定义提示**:前端订阅 `wails:updater:update-available` 事件,用自己的 UI 提示而非内置窗口。
