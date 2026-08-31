# 2026-09-01 unified-installer-linux-release

## 起因

承接 EchoBird 分发调研与 Mac install.sh(未提交稿)。用户拍板:**只做 Mac + Linux,Windows 显式搁置**;要求统一安装脚本 + 落地 Linux 发布管线。上轮调研已确认:Windows 代码本来就编不过(terminal/acp 裸用 Unix syscall),搁置无成本。

## 决策

1. **统一脚本 = 单文件 POSIX sh 双分支**。Windows 不是 sh 能表达的(`curl|sh` 不存在),脚本对非 Darwin/Linux 统一报错指引,不硬塞。
2. **Linux 走 deb/rpm 而非 AppImage**:nfpm 配置已就绪(gtk4/webkitgtk6.0 依赖声明 + desktop 文件 + postinstall 钩子);包管理器能解依赖,AppImage 缺 webkit2gtk 就是不启动的空壳。Arch/NixOS/Alpine 落手动指引(与 EchoBird 同取舍)。
3. **资产契约**:`monkey-deck-linux-<arch>.deb/.rpm`(amd64/arm64),与 mac zip 同发一个 SHA256SUMS。已核对 wails3 updater 的 `parseChecksumLine` 按文件名精确匹配,deb/rpm 行混入不破坏 mac 更新器。

## 实现(改了哪些文件)

- `scripts/install.sh`(重写为双分支):OS gate 提前(不支持的系统不碰网络);共享 `fetch_verified`(sha256sum/shasum 双兼容)+ 非交互 up-to-date 退出;mac 分支同前(zip/seal/staged swap);linux 分支 dpkg→dnf/zypper/yum/rpm 检测 + `dpkg -s`/`rpm -q` 读已装版本 + `dpkg -i`/`apt-get -f` 修依赖。shellcheck 全绿。**自查发现并修正一个误判**:`set -e` 下 `[ a = b ] && fn` AND-list 尾段失败有豁免(实测),本来无 bug,但统一改 `if` 形态更清晰。
- `Taskfile.yml` 新增 `release:linux`:双架构 `linux:build` → repo 根目录循环 nfpm 打 deb+rpm → 重命名契约名 → SHA256SUMS + gh 命令提示。
- `build/linux/nfpm/nfpm.yaml`:version 改 `${VERSION}`(实测 nfpm 对 version/arch 等标量字段默认展开 env);maintainer 补真实值(原 `${GIT_COMMITTER_*}` 未设时空着);二进制条目改 `${MDPKG_BIN}` + `expand: true`(**坑:contents 条目默认不展开 env,必须显式 expand**;标量字段(version/arch)默认展开,两套行为不一致)。
- `build/linux/Taskfile.yml`:native build ldflags 补 `-X main.currentVersion={{.VERSION}}`(与 darwin 对齐);VERSION var(git describe)上移到 vars。
- `build/docker/Dockerfile.cross`:build.sh 增 `APP_VERSION` env → ldflags 注入;`build:docker` 任务透传。
- `scripts/ci/installer-test.sh` + `.github/workflows/test-installer.yml`(上轮已写,随本 commit 入库):macos runner 上 8 场景 E2E,本地 http.server 假 release 驱动。

## 验证

- nfpm 链路实证(本机 mac,假二进制):`VERSION=3.2.1 GOARCH=amd64 MDPKG_BIN=... wails3 tool package` → deb `Version: 3.2.1-1` / `Architecture: amd64` / **payload 内是正确架构的二进制**(解包 cat 确认);rpm 头部 `monkey-deck-3.2.1-1`。双架构循环互不覆盖。
- **cwd 坑实证**:nfpm contents.src 相对 cwd 解析,`cd bin` 跑会找不到 `./build/appicon.png`;任务最终形态 = repo 根 + `-out ./bin`。
- shellcheck 0 warnings;Taskfile/nfpm YAML 解析通过;不支持的 OS 立即报错(实测 FreeBSD 形态路径)。
- linux 双架构真实构建未跑(本机无 GTK CGO 工具链,docker wails-cross 镜像未建)——CI ubuntu runner / 首次发布时是首要验证点。

## 下一步

- push 后看 `test-installer` workflow 首跑(macos-14/15)。
- 首个 release 发布前:跑一次 `task release:linux`(需先 `task setup:docker` 建 cross 镜像,或直接在 CI ubuntu runner 构建双架构);发布时 darwin+linux 资产同目录重汇 SHA256SUMS。
- README 加 `curl | sh` 安装行(等仓库/域名就绪)。
