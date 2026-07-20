# 2026-07-20 harness 升级/查新委派给 harness 自己的命令

## 起因

设置面板里的「harness 升级」逻辑不友好:绕开了 harness 自己的升级基建,自己重新发明轮子,还发明得不全。

实测 OMP / opencode CLI 后确认:

| | 现在的写法 | harness 自己提供的方式 |
|---|---|---|
| **opencode 查最新** | 手搓 GitHub API `GET /repos/sst/opencode/releases/latest` | ❌ 无纯 check 命令(只能跑 `upgrade`) |
| **opencode 升级** | 手搓 `curl -fsSL https://opencode.ai/install \| bash` | `opencode upgrade`(支持 `--method` 选 curl/npm/bun/brew/choco/scoop) |
| **omp 查最新** | ❌ `Source=nil`,永远查不到 | ✅ `omp update --check`(原生 check-only) |
| **omp 升级** | ❌ `Upgrader=nil`,返 `ErrUpgraderNotConfigured` | `omp update`(原生支持) |

具体不友好点:
1. **opencode 升级写死 curl** —— 若用户原本用 `npm i -g opencode` 装,monkey-deck 跑 curl 会装出第二份独立副本,与 npm 全局版本打架。`opencode upgrade` 自带 `--method` 让 opencode 自己按原安装方式升级。
2. **omp 完全没接进去** —— omp 原生就有 `omp update --check` + `omp update` 的完整闭环,比 opencode 还方便。
3. **GitHub API 限额** —— 完全可以避免的外部依赖,opencode 换发布渠道会坏掉,而 `opencode upgrade` 不会。

## 设计

核心思路:**优先委派给 harness 自带的 update/upgrade 子命令**,只有当 harness 无此能力时才回退外部源(如 GitHub)。

`ReleaseSource` 接口已有,只需加一种实现:`CommandSource`(跑命令 + 按规则提取版本)。

### 提取策略(关键不变量,§5.3)

`omp update --check` 的真实输出:
```
Current version: 17.0.3
New version available: 17.0.5
Wall time: 1.88 seconds          ← 在 stderr,CombinedOutput 会混进来
```

有两个版本号!直接复用 `extractVersion` 会抓到 **`17.0.3`(Current)**,而不是 `17.0.5`。属于「输出第几行」启发式 → 脆弱,禁用。

策略:
- **Pattern 非 nil**:用单 capture group 锚定关键词(如 `New version available:\s*(\S+)`),与输出顺序、stderr 混入无关 —— 这是协议稳定标识思想。
- **Pattern nil**:回退 `extractVersion`(向后兼容简单 `<bin> --version` 风格命令)。

自洽性:「已是最新」时 omp 输出无 `New version` 行 → Pattern 不匹配 → `Latest` 返 error → Discover 把 `LatestVersion` 留空 → 前端按 `installed && !upgradeAvailable && !upgradeError` 走「已是最新」徽章分支。无需特判。

## 改法

- **`internal/harness/release.go`**:新增 `CommandSource{Cmd, Pattern}`,实现 `ReleaseSource`。
- **`internal/harness/registry.go`**:
  - opencode:`Upgrader` 改成 `CommandUpgrader{Cmd: ["opencode","upgrade"]}`(从写死的 curl install 脚本改为委派);`Source` 保留 `GitHubSource`(opencode 无纯 check 命令,继续查 GitHub)。
  - omp:新增 `Source: &CommandSource{Cmd: ["omp","update","--check"], Pattern: regexp.MustCompile("New version available:\\s*(\\S+)")}`;新增 `Upgrader: CommandUpgrader{Cmd: ["omp","update"]}`。
  - 加包注释「委派优先原则」。
- **`internal/harness/discover_test.go`**:新增 5 个 `TestCommandSource_*` 测试(Pattern 提取、Pattern 不匹配=已是最新、回退 extractVersion、命令失败、空 Cmd)。
- **i18n(`zh.json`/`en.json`)**:`upgradeTip` 从「官方安装脚本」改为「harness 自己的升级命令」,与新行为对齐。

## 验证

- `go test ./internal/harness/...` —— 13 个测试全过(含新增 5 个)。
- `go build . ./internal/...` —— 通过(仅 macOS linker 版本警告,无关)。
- **真实环境验证**:写一次性 Go 脚本实跑 `omp update --check`,确认 Pattern 从真输出里抓到 `"17.0.5"`(不是 `17.0.3`),stderr 的 `Wall time` 行不影响。

## 下一步

- omp / opencode 的 CommandSource/CommandUpgrader 在 GUI 启动时可能踩 §3.2 GUI PATH pitfall —— 但这些是用户在设置面板手动点击时触发(chat service 的 Refresh/Upgrade),不是启动时,通常用户登录 shell 的 PATH 有这些命令。若将来报「找不到 omp」,再统一处理(CommandSource/Upgrader 走 PATH 注入)。
- 若 opencode 将来加 `--check` / `--dry-run`,可把 Source 也换成 CommandSource,统一模式。
