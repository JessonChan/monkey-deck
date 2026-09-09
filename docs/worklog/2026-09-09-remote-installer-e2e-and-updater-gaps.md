# 2026-09-09 remote-installer-e2e-and-updater-gaps

## 起因

用户问「自动升级是完整的吗」,并提供两台测试机(一台 Linux x86_64、一台 macOS arm64,具体机器信息不入库)做 install.sh 完整脚本测试。要求:测试机器的 IP/用户名等信息**不得提交进仓库**。

## 结论(先答问题):自动升级完整性审计

- **macOS:链路完整**。版本(ldflags 注入 currentVersion)→ GitHub provider 匹配 `monkey-deck-darwin-<arch>.zip` → SHA256SUMS 校验 → 解压 → helper swap(整个 .app)→ `open -n` 重启。此前已实证 seal/quarantine/启动全绿。
- **Linux:升级缺口(本轮已修一个,还剩一个已知限制)**:
  1. **[已修] updater 会把 deb 资产当更新包**:`DefaultAssetMatcher` 按名字含 platform+arch 匹配,`monkey-deck-linux-amd64.deb` 命中 → 下载后不解包直接 rename 成二进制 → **把安装搞坏**。修法:`internal/update` 加 `archiveOnlyAssetMatcher`(排除 .deb/.rpm/.exe/.dmg 等,双向 arch 别名),matcher 落空时 Check 报干净的 "no asset for linux/amd64"。配 6 场景单测(含 x86_64↔amd64 双向别名、deb/rpm 排除)。
  2. **[已知限制] Linux 上自动升级整体不可用**——即使发 linux zip 资产,helper swap 只替换 `.app`(darwin)或裸可执行文件,Linux 包管理器装的 `/usr/local/bin/monkey-deck` + dpkg 数据库版本不会跟进,swap 后 dpkg 仍认为旧版。Linux 的「升级」路线 = 重跑 install.sh(deb/rpm 包管理器路径,本轮已验)。将来若要 Linux 内置自更新,需 zip 资产 + 更新 .desktop/版本记录的策略,显式推迟。
- install.sh 侧:deb/rpm 行混入 SHA256SUMS 不影响 mac 更新器(`parseChecksumLine` 按文件名精确匹配,已读上游源码确认)。

## 本轮修复的三个 bug(全部测试机实证)

1. **install.sh deb 版本比较永假**:nfpm deb 的 `Version: 9.9.9-1` 带 packagement release 后缀,与裸 semver tag 比较永不相等 → 「已是最新」永不触发、每次重装。修:`dpkg -s` 读出后 `sed 's/-[0-9][0-9]*$//'` 剥后缀(rpm `%{VERSION}` 本来就裸)。
2. **harness 场景 6 假失败**:`zip -r` 对已存在 zip 是**追加更新**而非重建——前一场景留下的好 zip 里 .app 还在,junk/ 只是加进去 → installer 合法接受,断言「必须拒绝」失败。隔离复现实锤 install.sh 行为正确(EXIT:1)。修:场景 6 打 zip 前 `rm -f` 旧包。
3. **harness 可移植性**(实机踩坑):macOS 无 `timeout` 命令(改手动 watchdog);POSIX sh 函数变量全局共享,`make_release` 调 `make_app` 后 `$d` 被 callee 覆写(`cd x/x` 报错)——改用不相交变量名;`set -u` 下 PASS/FAIL/SRV_PORT 未初始化;扁平部署(非 repo 结构)的 REPO_ROOT 回退。

## 测试(两台实机,测试后已清理)

- **macOS(arm64)完整 harness:20/20 全绿**。8 场景:全新安装(seal/版本/无 quarantine/二进制可执行)、升级 0.0.1→9.9.9(backup 清理/seal)、up-to-date 非交互不挂起、篡改 SHA256SUMS 拒绝、缺 manifest 拒绝、zip 无 .app 拒绝、破 seal 拒绝、架构资产映射(本架构 200/对侧 404)。
- **Linux(x86_64,Pop!_OS 24.04)免 root 场景**(sudo 需密码交互,实装 deb 由用户后续手动验):真实 ELF 假二进制打包的 deb + 本地 http.server——校验通过走到 sudo(边界正确)、篡改 SHA256SUMS 拒绝(EXIT 1)、缺 manifest 拒绝(EXIT 1)、`-1` 后缀剥离正确、对侧架构资产 404。
- 本地:`go test ./internal/update/` 全绿(含新 matcher 测试);shellcheck 0 error;两脚本 `sh -n` 通过。

## 改了哪些文件

- `internal/update/update.go`:archiveOnlyAssetMatcher + isChecksumAssetName + 双向 archContains。
- `internal/update/update_test.go`:TestArchiveOnlyAssetMatcher 6 场景。
- `scripts/install.sh`:deb 版本后缀剥离。
- `scripts/ci/installer-test.sh`:timeout 可移植化、函数变量冲突修复、场景 6 zip 追加 bug、扁平部署支持、set -u 初始化。

## 下一步

- Linux 首个 release 发布后,在真机手动跑一次 `install.sh`(含 sudo 实装 deb)收尾验证。
- Linux 内置自更新(zip + 版本记录策略)显式推迟;当前 Linux 升级走重跑 install.sh。
- push 后 CI(workflows 已入库)首跑。
