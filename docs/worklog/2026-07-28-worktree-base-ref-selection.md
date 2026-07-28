# 2026-07-28 worktree 显式基线分支选择(不回退 HEAD)

## 起因

新建 session 的 worktree 基线完全不受控:`internal/chat/chat.go` `CreateSession` 调 `worktree.Create(repoPath, branch, wtPath, "")`,第四参 `baseRef` 永远传空 → `worktree add ... HEAD` → **永远基于主仓库此刻的 HEAD**。

即 session 的基线取决于「建 session 时主仓库偶然 checkout 在哪个分支」(master / main / develop / 某 feature 都可能),隐式且不可预测。连带 `MergeSession` 合到主仓库当前 HEAD 也不受控——「从哪岔出去」和「合回哪」两头都失控。

违反 §5.3「找不变量」:基线应是稳定可控的显式选择,而不是「此刻 HEAD」这个会飘的不变量。

## 设计(契约:todo/worktree-base-ref-selection.md)

**Route A strict:基线永远显式可控,绝不裸用 HEAD。**

- **双层强制**:前端没选基线 → 禁用「新建」;后端 `baseRef` 空 & 探测不到 → 报错。
- **baseRef 存本地分支名**(main/develop/feature-x,不存 origin/main):merge target 必须是本地分支,把「checkout-from」和「merge-back-to」绑成一个(从哪来、回哪去对称)。
- **默认探测偏向本地**:origin/HEAD symbolic-ref → refs/heads/main → master → origin/main → origin/master,第一个存在的返回短名;全空 → `ErrNoBaseRef`。
- **SQLite 是真相**(§1.5):base_ref 列存本地分支名,不镜像 git config。
- **预选(非强制)**:探测到默认就预填进选择器 + 星标(常见情况一键创建);探测不到则必选,绝不静默回退 HEAD。

### review 时修正的 3 点(开工前回写设计文档)

1. **migration 号 0009 → 0013**(0009-0012 已被占用,硬错误)。
2. **`DiffStat`/`BranchLog` 的 base 要跟基线走**(原 base 是主仓库 HEAD,显式基线后 HEAD 会飘,增量会算错;加可选 base 参数)。
3. **砍掉「target 被其他 session 的 worktree 占用」死分支检测**(app 只建 md/<id> 分支,基线分支永不被 session worktree 占用,跨 session 遍历检测违反 KISS;降级为 worktree list 发现 target 在主仓库之外被 checkout 才报错)。

## 改法

### 1. worktree 原语(`internal/worktree/worktree.go`)

- `ErrNoBaseRef`:探测不到默认基线(Route A strict 不回退 HEAD)。
- `ResolveDefaultBaseRef(repoPath)`:origin/HEAD symbolic-ref → 本地优先 probe list → ErrNoBaseRef。
- `ResolveAddBaseRef(repoPath, baseRef)`:命名空间消歧(refs/heads vs refs/remotes vs tag),避免短名被 git 解析成同名 tag。
- `ListBranches(repoPath)`:for-each-ref 本地+远程,排除 */HEAD,封顶 200,供选择器。
- `MergeBranchInto(repoPath, branch, target, message)`:合回指定 target。先用 `worktree list --porcelain` 定位 target 在哪被 checkout:
  - 主仓库在 target 且干净 → 直接 merge。
  - 主仓库在 target 但脏 → 报错。
  - target 空闲(主仓库在别的分支)→ 建 target 的**临时 worktree**,在其中 merge 后 `defer` 删除;主仓库不动。
  - target 在主仓库之外被 checkout → 报错。
- `Create` 加 `--no-track`:避免首次 push 前 git status 误报 "behind by N"。
- `DiffStat`/`BranchLog` 加可选 `base` 参数(空=HEAD 旧行为,非空=用 base 作 merge-base)。

### 2. chat service(`internal/chat/chat.go`)

- `CreateSession` 签名加 `baseRef string`:空则探测默认(探测不到返回 `errBaseRefRequired`);非空则 `ResolveAddBaseRef` 消歧后传给 `worktree.Create`;成功后 `SetSessionBaseRef` 落库(存用户选的短名)。
- `MergeSession`:有 `BaseRef`(新 session)调 `MergeBranchInto(target=se.BaseRef)`;空(旧 session)沿用 `MergeBranch`(合到主仓库 HEAD)。
- `SessionDiff`/`SessionChanges` 的 `DiffStat`/`BranchLog` 调用传 `se.BaseRef`。
- 新增 binding:`ResolveBaseRefDefault(projectID)` 返回 `{BaseRef, Ok}`;`SearchBaseRefs(projectID)` 返回 `[]BranchInfo`。

### 3. store(`internal/store/`)

- `Session.BaseRef string` 字段。
- `migrations/0013_session_base_ref.sql`:`ALTER TABLE sessions ADD COLUMN base_ref TEXT NOT NULL DEFAULT ''`。
- `sessionColumns`/`scanSession` 加 base_ref;`SetSessionBaseRef` 方法。

### 4. 前端

- `NewSessionModal.tsx`:worktree=true 时显示基线选择器(轻量 CSS/DOM 自研 combobox,§4.6)。预选 + 星标 + 可搜索 + local/remote 徽标 + 必选态。`canConfirm` 加 `worktree===true → baseRef 必选`。
- `App.tsx`:`createSession` 预取 `ResolveBaseRefDefault` + `SearchBaseRefs`;`confirmNewSession` 透传 `baseRef` 到 `CreateSession`。
- i18n zh/en:`newSession.baseRef*` 系列 key。
- `wails3 generate bindings`(§0.5)。

## 踩坑(临时 worktree 路径)

实现 `MergeBranchInto` 的临时 worktree 分支时踩了两个 git 坑,均靠测试暴露:

1. **`--no-track --detach` 不兼容**:git 报 `--[no-]track can only be used if a new branch is created`。临时 worktree 检出已有分支(不建新分支),去掉 `--no-track`。
2. **`--detach` 导致 merge 不移动分支指针**:detached HEAD 下 `git merge` 只更新 HEAD,不移动 target 分支 ref → target 分支不会更新(测试「merge 没生效」暴露)。临时 worktree 必须**检出 target 分支(非 detach)**,merge 才会移动 target 指针。前面的占用检查已保证 target 未在别处被检出,此处 `worktree add <dir> <target>` 能成功。

这是 review 点名的最复杂路径:临时 worktree 必须 `defer` 删除(无论成功/冲突/失败),单测 `TestMergeBranchInto_ConflictCleansTempWorktree` 专门覆盖「冲突时临时 worktree 被清理」。

## 改了哪些文件

- `internal/worktree/worktree.go`:+`ErrNoBaseRef`/`DefaultBaseRef`/`BranchInfo`/`ResolveDefaultBaseRef`/`ResolveAddBaseRef`/`ListBranches`/`MergeBranchInto`/`mergeInDir`/`gitQuiet`/`revVerify`;`Create` 加 `--no-track`;`DiffStat`/`BranchLog` 加 base 参数。
- `internal/worktree/worktree_test.go`:6 个新测试(探测/消歧/list/merge-into 三场景含冲突清理)+ 2 个 helper。
- `internal/chat/chat.go`:`CreateSession` 签名+逻辑;`MergeSession` 双分支;`SessionDiff`/`SessionChanges` 传 base;+`ResolveBaseRefDefault`/`SearchBaseRefs` binding;+`errBaseRefRequired`。
- `internal/chat/{integration,last_harness,worktree_path}_test.go`:`CreateSession` 调用补 baseRef 参数。
- `internal/store/store.go`:`Session.BaseRef` 字段。
- `internal/store/sessions.go`:`sessionColumns`/`scanSession` 加 base_ref;`SetSessionBaseRef`。
- `internal/store/migrations/0013_session_base_ref.sql`。
- `frontend/src/components/NewSessionModal.tsx`:基线选择器。
- `frontend/src/App.tsx`:预取+透传。
- `frontend/src/i18n/locales/{en,zh}.json`。
- `frontend/src/index.css`:ns-baseref* 样式。
- `frontend/bindings/`:regen。
- `todo/worktree-base-ref-selection.md`:设计契约修正(migration号/行号/补漏/§12拍板)。

## 验证

- `go test ./internal/...` 全绿(含 6 个新 worktree 原语单测 + 修正签名的 4 个测试调用)。
- 前端 `tsc --noEmit`:0 个非模块错误(剩余 "Cannot find module" 是 worktree bindings 噪声,固有)。
- 临时 worktree 路径的核心不变量(冲突也必清理)由 `TestMergeBranchInto_ConflictCleansTempWorktree` 锁定。

## 下一步 / OPEN

- **UI 实测**:需在 `wails3 dev` 实际点开 NewSessionModal 验证基线选择器交互(搜索/星标/必选态/tooltip)。本 worktree 环境无法起 GUI。
- **旧 session 迁移提示**:baseRef 空的旧 session merge 时沿用旧行为,文档约定加「一次性迁移提示」,目前未做显式提示(行为正确,只是没提示用户)。
- **多 remote / fork**:v1 写死 origin,多 remote 项目需用户手选(文档已标注限制)。
