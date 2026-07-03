# 2026-07-03 精简 AGENTS.md 并整理根目录文档与图标资源

## 起因

用户审视 AGENTS.md 后指出三类问题:
1. **信噪比低**:文件混入了「实现细节」(如 react-tooltip 的具体 API 用法)与「已落地修复的流水账」(§5.4 #10/#11/#12 含文件名、测试函数名),从「方向契约」退化为「代码规范 + changelog」混合体。
2. **硬编码本机绝对路径不可移植**:`/Users/jessonchan/temp/monkey-deck/references` 出现 9 处,换用户名/机器/父目录全废。
3. **根目录散放文档与图标**:`PROCESS.md`/`RELEASE.md`/`UPDATE_SOURCES.md` 与 3 个图标 PNG 散在根目录,应归类。

## 设计决策

- **references 用相对路径**:`references/` 是仓库根下真实目录(cwd 下相对路径 100% 可达,`real-agent-kanban` 虽是 symlink 但经 `references/` 入口照常工作)。原 §0.2「给 git worktree 用绝对路径」是伪需求——worktree 是 session 的 cwd(agent 跑命令处),不是 agent 读 AGENTS.md 的地方。
- **图片归 `assets/` 而非 `docs/assets/`**:这些 PNG 是图标设计源(最终流向 `build/appicon.png`),是项目级构建资源,不是文档插图。`icon.md` 的换图标处理链从项目根执行,`assets/xxx` 路径简洁。
- **精简原则**:架构契约(§0/§1/§2/§7/§3.3/§3.4)零丢失;只删实现细节、流水账、与他处重复的条目。§5.4 长坑记录(#10/#11/#12)已落地的修法细节下沉到既有 worklog,本文只留原则句。
- **§5.4 #9 并入 §3.2**:子进程回收三条原则(进程组/reap 时机/pgid 唯一真相)归口到 §3.2,§5.4 不再重复;#9「禁止写死命令字符串」教训有价值,补进 §3.2。

## 改法

### 1. 整理根目录结构(commit 1)
- `PROCESS.md`/`RELEASE.md`/`UPDATE_SOURCES.md` → `docs/`
- 3 个图标 PNG → 新建 `assets/`
- 引用更新:
  - `docs/icon.md`:换图标处理链(python PIL / sips)的 PNG 路径加 `assets/` 前缀;「设计源文件放在项目根目录」改「放在 `assets/`」。
  - `docs/RELEASE.md`、`docs/UPDATE_SOURCES.md`:`./internal/update/...` 链接改 `../internal/update/...`(移到 docs/ 后指向根代码需上一级);同目录互链 `./Xxx.md` 不变。
  - `AGENTS.md` §2.1 目录结构图:删根目录 PROCESS.md 行,加 `assets/`,`docs/` 展开,references 行去绝对路径。
- **构建不受影响**:app 图标真相来源是 `build/appicon.png`,根目录 PNG 只是人工换图标的设计源,`wails3 build`/`generate:icons` 不直接依赖。

### 2. 精简 AGENTS.md(commit 2)
- **去硬编码**:§0.1/§0.2/§0.4/§5.4 引言行所有 `/Users/.../references` → `references/`;§0.2 重写删「绝对路径给 worktree 用」整段;§0.5 删 `/Users/jessonchan/go/bin/wails3` 与会过时的 `v3.0.0-alpha2.106`。
- **§4.5 tooltip**:删「用法」条(`<Tooltip id="md-tip">`/`data-tooltip-place`/`--rt-*` 等 API 细节,已落在 `App.tsx`/`index.css`/`Sidebar.tsx` 等 10+ 处,属代码层)与重复的「理由」条,留原则。
- **§4.6 UI 选型**:~20 行压缩为 ~9 行,保留三约束全部硬约束性质与具体禁项;`backdrop-filter` 措辞改精确(「大面积重绘」而非全禁,呼应 memory 里 `.sidebar` 禁 backdrop-filter 的实测)。
- **§5.3**:11 条合并为 7 条——KISS+Less is More 合一;「修症状vs治根因」+「禁用启发式分段」+「能跑不等于对」+「最好修复是减代码」四条同主题(找不变量、不堆 if)合成一条。
- **§5.4**:12 条砍为 5 条——删 #1/#3(与 §3.5 重复)、#4/#5(§3.2 已覆盖)、#8(与 §0.5 重复)、#9(并入 §3.2)、#11(§5.3 主键归并原则已涵盖);#10/#12 收成原则句,落地细节去 `2026-07-02-timeline-key-merge-refactor.md` 等既有 worklog。
- **§8 自检**:18 条 → 8 条易忘项,删与 §1/§3 重复的架构硬约束转述(纯 ACP/client-server/cwd/SQLite/子进程/超时/权限/model 格式/结构化格式),末尾加一句说明架构约束不在自检重复。
- **补强 §3.2**:新增一条「回收必须 harness 无关:以 pgidFile 的 pgid 为唯一真相,禁止写死命令字符串做 grep」(自 §5.4 #9 下移)。

## 改了哪些文件

- `PROCESS.md` → `docs/PROCESS.md`(git mv,内容未改,只读归档)
- `RELEASE.md` → `docs/RELEASE.md`(git mv + 行 4 链接改 `../internal`)
- `UPDATE_SOURCES.md` → `docs/UPDATE_SOURCES.md`(git mv + 行 4 链接改 `../internal`)
- `monkey-deck-icon{,-v2,-v2-cropped}.png` → `assets/`(git mv)
- `docs/icon.md`(处理链路径加 `assets/` 前缀)
- `AGENTS.md`(§2.1 目录图 + §0.1/§0.2/§0.4/§0.5/§4.5/§4.6/§5.3/§5.4/§8/§3.2)

## 验证

- `grep /Users/jessonchan AGENTS.md` → 无匹配(本机绝对路径全清)。
- `grep monkey-deck-icon docs/icon.md` → 全部带 `assets/` 前缀。
- `docs/RELEASE.md`/`UPDATE_SOURCES.md` 行 4 链接确认为 `../internal/update/update.go`;同目录 `./PROCESS.md`/`./RELEASE.md` 互链正确。
- 根目录:3 文档 + 3 PNG 已移走,剩 AGENTS.md/Makefile/Taskfile.yml 等。
- `AGENTS.md` 363 → 322 行(-41,-11%)。
- 三个原子 commit:结构整理(0054ad2,8 文件)、AGENTS.md 精简(ecc95f8,+38/-79)、本 worklog。
- 纯文档/结构改动,无代码,无需 `go test`。

## 下一步

无。本次为文档与结构整理,不影响代码行为。
