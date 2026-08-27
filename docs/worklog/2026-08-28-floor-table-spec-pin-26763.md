# 2026-08-28 · floor 表规格钉死核验:5 行校准表即「内容即规格」终态,零值变更(#26763)

## 起因

Task #26763:「覆盖率 floor 表改为下表(内容即规格)」。

任务到达时只带标题,「下表」不在 payload 里——与 #26761 / #26762 同形,沿用既定处理:**按仓库现状做最佳解释执行**。本系列的收敛轨迹已经把「下表」钉死了:

- #26760 定稿校准值:核心四包紧 floor(acp 58 / chat 65 / harness 85 / store 67)+ `internal/update -` 豁免 + 其余 40;
- #26761 把「缺行」语义改为按脚本默认 40 校验;
- #26762 把表收敛为恰好承载校准信息的 5 行(其余与默认 40 逐字重复的行全删)。

「内容即规格」的合理解读:这份 5 行校准表的内容就是规格本体,按字面钉死、不做二次发挥。仓库现状与之逐字节一致,因此本任务执行形态为**规格核验**(同 #26761「核对……一个值都没动」的前半程,以及 verify-only 任务 #26384 的先例):不发明数值(表中数值丢失,编造即捏造)、不抬高/压低任何行(都会推翻 #26760 的显式决策)。

## 方案与决策

- **两个 floor 文件零改动**:
  - `scripts/coverage.floor` = `go 69` / `frontend 64`(标量,自 #26721 起未动,#26760 确认不动);
  - `scripts/coverage.floor.pkgs` = 5 行(acp 58 / chat 65 / harness 85 / store 67 / update -),与 #26760 定稿、#26762 收敛形态逐行一致。
- `scripts/coverage-floor.sh`、`TESTING.md` **零改动**:头注释(Calibration policy / 缺行默认 40)与文档(5 行表形态、默认 40 口径)在 #26760–#26762 已全部对齐,无残留旧措辞。
- 新增本 worklog 条目作为唯一产出:规格核验的实测证据(下节)即「下表 = 现表」的证明。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `docs/worklog/2026-08-28-floor-table-spec-pin-26763.md` | 新增(本条) |
| `scripts/coverage.floor` / `scripts/coverage.floor.pkgs` / `scripts/coverage-floor.sh` / `TESTING.md` / 前端 / Go 源码 | **零改动** |

## 验证

- **fresh worktree 全量实测**(补 `bun install` 后 `make cover`;373 前端测试全绿,7170 asserts):
  - go 总覆盖率 **69.2%** ≥ floor 69;前端行覆盖率 **64.7%** ≥ floor 64;
  - 逐包实测:核心四包 **58.1 / 65.5 / 85.5 / 67.9** 与紧 floor 58/65/85/67 逐个吻合;`internal/update` 5.9%(豁免行 `-`);其余 10 包 74.9–94.3,全部 ≥ 默认 40。
- **守门全绿**:`bash scripts/coverage-floor.sh coverage.out` exit 0——`OK go 总覆盖率`、`OK 前端行覆盖率`、4×OK + 10×DEFAULT + 1×EXEMPT、`OK 分包 floor 14/15(1 包豁免)`。
- **棘轮咬合(负面对照)**:临时把 acp 行抬到 99 → 恰一条 `FAIL 分包 internal/acp 58.1% < floor 99%`,exit 1——表在 fresh 实测上真实承重,非摆设。验后从备份还原,`git diff` 干净,表与 HEAD 逐字节一致。
- `bash -n scripts/coverage-floor.sh` 干净;探针备份即用即删,仓库内无临时文件残留。
- **三端(§4.7)**:`frontend/` 零改动、无 UI/binding/event 面,三端矩阵不适用;前端测试套件(373)作为守门输入随 `make cover` 全绿即本任务前端面验证。

## OPEN / 下一步

- 若用户的「下表」与本系列收敛值有出入(数值在任务派发链路中丢失,无从比对),正确动作是拿原表逐行 diff 后**手改表**再走本条同款核验;在此之前,本系列 #26760 定稿 + #26762 收敛形态就是唯一有据可依的规格。
- `--set-pkgs` 的 ⚠ 警告(#26760)继续有效:误用会把 5 行表长回 15 行紧 floor。
