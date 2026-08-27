# 2026-08-28 · floor 表换校准值:核心四包 + 其余默认 40,修 fresh clone 复现的 terminal 误爆(#26760)

## 起因

#26721 建分包棘轮时,15 包 floor 全部按当天实测向下取整(贴地紧 floor);#26759 终轮校准确认了「本机数值全部仍准」。但**贴地紧 floor 对环境敏感包不成立**:`internal/terminal` 是 pty 平台代码,其实测覆盖率随机器 / Go 工具链 / 平台漂移——fresh clone 上 terminal 实测跌破 83,守门稳定误爆,且 FAIL 出口(「补测试或 --set-pkgs」)对这种环境性漂移根本不适用(补测试无用,--set-pkgs 又会把错误基准写死)。误爆复现路径:fresh clone → `make cover-check` → `FAIL 分包 internal/terminal xx% < floor 83%`。

## 方案与决策

**分包 floor 表从「全包贴实测」改为「核心四包贴实测 + 其余默认 40」**:

- **核心四包** = `internal/acp`(58)/ `internal/chat`(65)/ `internal/harness`(85)/ `internal/store`(67)——纯逻辑的 ACP 主干(协议层 → harness 适配 → chat 事件编排 → SQLite 真相,AGENTS.md §1.1/§1.5/§1.6/§2.1 的架构核心),测试确定性高、跨环境漂移小,值得继续贴地紧棘轮。数值与原表一致(本日实测 58.1 / 65.5 / 85.5 / 67.9 向下取整吻合)。
- **其余 10 包一律 40**(config / fsview / mcp / permissions / remote / shellenv / terminal / titlegen / ui / worktree):40 挡得住「删测试式粗放稀释」(当前非豁免包最低实测 58.1,距 40 余量 18pt),环境漂移零点几到几个 pt 不再误爆。聚合稀释仍由 `go 69` 总 floor 兜底。
- **`internal/update -` 豁免行原样保留**(#26759 刚落,实测 5.9%,写 40 = 必失败)。
- **标量 floor 不动**(`go 69` / `frontend 64`),脚本逻辑零改动——这是数据(策略)变化,不是机制变化。
- **代价(显式接受)**:非核心包从「贴地棘轮」降为「粗放棘轮」,82→50 这种非核心包内的中幅稀释不再单独报警,只体现在 go 总覆盖率上。这是任务对「误爆频率 vs 棘轮粒度」的取舍:守门的价值在「可信地绿」,狼来了的守门会被绕过。

同步文档:

- `scripts/coverage-floor.sh` 头注释补一段 **Calibration policy**:写明核心四包是谁、为什么其余默认 40、以及 ⚠ **`--set-pkgs` 会整份重写回贴实测紧 floor**(把默认 40 全部抬高、误爆回归),仅在确有意图时使用。
- `TESTING.md` floor 守门节补同款校准策略说明(中文,§3.7 文档不限英文)。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `scripts/coverage.floor.pkgs` | 10 个非核心包 floor → 40;核心四包(acp 58 / chat 65 / harness 85 / store 67)与 `internal/update -` 不动 |
| `scripts/coverage-floor.sh` | 仅头注释:Calibration policy 段(核心四包 / 默认 40 理由 / --set-pkgs 重写警告);逻辑零改动 |
| `TESTING.md` | floor 守门节补校准策略段(含 --set-pkgs 警告、单包抬杠手改) |
| 前端 / Go 源码 | **零改动**(纯守门数据与文档) |

## 验证

- **`make cover-check` 全绿**:exit 0,`OK go 总覆盖率 69.2% >= floor 69%`、`OK 前端行覆盖率 64.7% >= floor 64%`、`EXEMPT internal/update(5.9%)`、`OK 分包 floor 14/15(1 包豁免)`。本日实测逐包核对:核心四包 58.1/65.5/85.5/67.9 均 ≥ 紧 floor,其余 10 包最低 58.1 均 ≥ 40。
- **误爆 A/B 实证(核心验证)**:手工 doctor 一份 profile,把 terminal 已覆盖语句每 16 条翻 1 条 → terminal 实测 **78.9%**(模拟 fresh clone 漂移形态)。同一份 profile:**旧表(terminal 83)→ `FAIL 分包 internal/terminal 78.9% < floor 83%`,exit 1(误爆复现);新表(terminal 40)→ exit 0(修复生效)**。演练后临时文件即删,真表从备份还原,`git diff` 确认仅 10 行变化。
- **失败路径回归**:标量 `COVERAGE_FLOOR=99.9` → FAIL exit 1(出口提示正常);分包路径把 chat 临时抬到 66(> 实测 65.5)→ `FAIL 分包 internal/chat 65.5% < floor 66%`,exit 1,其余族照常报告——分包棘轮机制未因数据变化受损。
- **脚本静态检查**:`bash -n` 干净;逻辑零改动,`--set-pkgs` 保留豁免行为沿袭 #26759 实测,不重复演练。
- **Go 门**:`go build ./...` + `go vet ./...` 干净(worktree 先 `bun run build` 补出 frontend/dist 供根 package go:embed——fresh worktree 既有前置,非本次改动)。
- **三端(§4.7)**:`frontend/` 源码零改动、无 UI/binding/event 面,三端矩阵不适用;前端测试套件(373)作为守门输入随 `make cover` 全绿即本任务前端面验证。

## OPEN / 下一步

- 核心四包若哪天也出现环境性漂移误爆,同样降级到默认 40 或改用「实测 − N pt 余量」口径;当前四包全为纯逻辑单测,无此前兆。
- `--set-pkgs` 仍是「整份重写回紧 floor」的语义,校准策略只活在数据文件与文档里(策略不进代码,KISS);误报复发时的正解是手改表,不是 --set-pkgs。
