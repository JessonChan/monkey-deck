# 2026-07-30 进入已有 worktree(owner / guest 模型)

## 起因

原 worktree 只能「新建独立分支」(owner,`md/<id>`),无法让多个 session 共享同一个已建好的工作目录。用户场景:同一 worktree 里跑两个 agent 协作 / 互相 review。旧的「使用项目当前目录」也只是切到 main 那一个固定目录。

需求:新建对话时能**直接进入一个已存在的 worktree**(不是再 checkout 一次),实现「一个 worktree 的分支可挂多个 session 对话」。连带要求:
- 不替用户做选择(workdir 也不预选,硬性选)。
- 只有创建 worktree 的 owner 能删它;进入者(guest)只删自己的聊天。
- guest 无权 / 无需合并。
- 删 main 主目录这类客户代码必须绝对防住。

## 设计(关键决策,均经用户拍板)

**身份三态,字段推导,免迁移:** `project` / `owner` / `guest`,从 `Session.WorktreePath/Branch/ID` 推:
- `WorktreePath==""` → project;
- `Branch == md/<自己id8>` → owner(§1.4 md/<id> 约定);
- 否则 → guest(进入已有 worktree,Branch 是别人的)。
单一真相:`worktree.MDPrefix` 常量。

**能删否 = git 真相 + md/ 约定,不是 DB 标记。** 四道护栏(任一不满足 → `worktree.Remove` 报错、什么也不动):
1. 目标路径归一化后 ≠ 主工作树(`EvalSymlinks+Clean`,防软链/尾斜杠误判);
2. 分支必须 `md/` 前缀(main/develop/feat 真实分支一律拒);
3. 必须是 `git worktree list` 里现存的 linked worktree(已删/失效 → 拒);
4. git 自身拒删主工作树。
→ main 主目录、guest、CLI 建的外来 worktree 永不可能被 app 删。身份(owner/guest)标在 session 字段(主信号);git 真像是删除时的兜底校验。

**「删 worktree」是独立原子操作。** `DeleteSession` 永远只删聊天 + 关 harness + 删 DB,**不碰 worktree**;`DeleteWorktree`(owner-only)才删 worktree。前端编排。

## 改法

### 后端
- `internal/worktree`:`ListWorktrees`(主+linked,IsMain 推导)、`ResolveWorktreeBranch`(校验路径是现存 linked worktree 并从 git 解析 branch)、导出 `MDPrefix`;`Remove` 加四道护栏。
- `internal/store`:`SessionsByWorktreePath`、`ClearWorktreeRefsByPath`(detach guest 用)。
- `internal/chat`:
  - `CreateGuestSession`:把 session 钉到已有 linked worktree(guest),不建分支、无 baseRef,branch 从 git 解析(不信前端)。
  - `WorktreeKind` / `WorktreeGuests`:前端删除流程 + 合并禁用用。
  - `DeleteWorktree`(owner-only,跑 Remove)、`DetachWorktreeGuests`(清 guest 引用→退回主目录)。
  - `DeleteSession` 改 chat-only;`RemoveProject` 删 DB 后逐个删 owner worktree;`SessionMergeable` guest 短路 false。

### 前端
- `NewSessionModal`:重写为 workdir 模式 —— ①「使用已有工作目录」选择器(项目主目录 + linked worktree,不预选;选主目录→project,选 linked→enter)②「新建独立 worktree」基线选择器(默认/最近/全部,不预选)。`onConfirm` 改 `NewSessionChoice{mode: project|enter|new}`。
- `App.tsx`:`createSession` 预取 `ListWorktrees`;`confirmNewSession` 按 mode 分发 CreateSession/CreateGuestSession;`removeSession` 编排(查 kind+guests,owner 带 guest 交给三选项弹窗);抽出 `purgeSessionState` 复用;`confirmDeleteWorktree`(all / keep)。
- `DeleteWorktreeDialog`(新):取消 / 删 worktree+所有对话 / 删 worktree+本对话保留其它(后者 detach guest)。
- `GitPanel`:guest 合并按钮禁用 + 「无权合并,只有 owner 能合并」提示;`SidePanel` 透传 `isGuest`(App 打开 session 时查 WorktreeKind)。
- i18n:existing*/worktreeMain/Linked/Detached、deleteWt.*、gitPanel.mergeGuest/GuestTip;CSS:删除弹窗样式。移除废弃的 shareTitle/shareDesc。

## 改了哪些文件

后端:`internal/worktree/worktree.go`(+`worktree_test.go`)、`internal/store/sessions.go`、`internal/chat/chat.go`(+`guest_test.go`)。
前端:`frontend/src/components/NewSessionModal.tsx`(+`.mount.test.tsx`)、`App.tsx`、`DeleteWorktreeDialog.tsx`(新)、`SidePanel.tsx`、`GitPanel.tsx`、`i18n/locales/{en,zh}.json`、`index.css`。
bindings:regen(`frontend/bindings/`,gitignored)。

分支 `feat/worktree-enter-existing`,7 个原子 commit(5 feat/docs + 2 fix):
- `ba7cb2a` worktree 原语(ListWorktrees + Remove 四道护栏 + 单测)
- `f130658` owner/guest 后端(CreateGuestSession + WorktreeKind/Guests + DeleteWorktree + Detach + DeleteSession chat-only + SessionMergeable guest + 单测)
- `44564ac` 弹窗 workdir 模式 + 已有工作目录选择器 + mount 测试
- `3b9f09c` 删除流程 + 三选项弹窗 + guest 合并禁用
- `2edbf3d` fix:补 ChatService.ListWorktrees binding 包装(见踩坑)
- `4a5d1fc` fix:适配严格 binding 的 null 类型

## 验证

- `go test ./internal/...` 全绿(worktree 4 道护栏单测 + chat guest 模型 5 个单测)。
- i18n JSON `python3 json.load` 两份均合法(踩了两次尾逗号坑:`mergeNothingTip` 原是末项无逗号,新增 key 后忘加 / 新末项 `mergeGuestTip` 多了逗号,均已修)。
- 前端 `bun run tsc --noEmit` 0 错。**但 `bun tsc` 对 .js binding 宽松,漏了真问题;以 `wails3 task build` / `package` 为准**(见踩坑)。修复后 build + package 均 ✓(`Monkey Deck.app` 生成并 ad-hoc 签名)。
- 前端 `bun run test` **150 pass / 0 fail**(含 NewSessionModal mount 测试 3 个:不预选 Create 禁用 / existing 选择器分组+选 linked→enter / new 基线分组+选→new)。
- 测试覆盖行为;**GUI 真实渲染待用户在桌面 app 验证**(workdir 选择器、三选项弹窗、guest 合并禁用提示的视觉)。

## 踩坑

1. **漏 ChatService binding 包装 → wails3 task build 报 IMPORT_IS_UNDEFINED**:`ListWorktrees` 只加在 worktree 包(包级函数),前端却调 `ChatService.ListWorktree` —— 该 binding 不存在,导出 undefined。`go build` / `go test` / `bun tsc`(对 .js binding 宽松)全过,只有 `wails3 task build` 的 vite/rolldown 阶段拦住。**教训:Go 加了包级函数不够,前端要用的必须再包一层 ChatService 方法;且验收要以 `wails3 task build` 为准,不能只信 `bun tsc`。** 已照 SearchBaseRefs 补包装。
2. **wails binding .ts/.js 格式抖动暴露 null 类型**:`wails3 generate bindings` 每次产出的 .ts/.js 严格度不稳(记忆里的已知坑)。这次 regen 产出严格 .ts(指针返回 `T|null`),暴露三处:`confirmNewSession` 的 `se`、`removeSession` 的 `guests`、`refreshConfig` 的 `sid`(后者是预存 latent,严格 binding 才显形)。统一做 null 守卫修复。

## 迭代(同日,UX 打磨)

用户 review 后提了 3 个 NewSessionModal 小问题,均已修(`dd554ce` + `7ff30dd`):
1. **点外面行为反了**:弹窗遮罩原 `onClick={onCancel}` 点外面就关 → 去掉,弹窗只能靠取消/Esc 关;下拉列表反之加 document mousedown 监听,点下拉外面自动收起(原「不选就一直挂」)。
2. **切模式高度跳**:选择器 hint「已有目录」1 行 / 「基线分支」2 行 → `.ns-baseref-note` 固定 `min-height:2.8em`(2 行),切换不再撑高。
3. **快捷选择**:两个选择器触发框下常驻 main + 最近 2 个 chip,点一下直选(免展开)。基线=默认+recentRefs[:2];已有目录=项目主目录+按 HEAD date 倒序前 2 个 linked(后端 `WorktreeInfo.Date` 用一条批量 `git log --no-walk` 取齐)。选中后 chip 行原样常驻高亮。

## 下一步 / OPEN

- **GUI 实测**:桌面 app 点开弹窗验证两选择器、三选项删除弹窗、guest 合并禁用提示的视觉与交互(尤其跨 worktree 共享目录时两 agent 并发的文件竞争——已提示用户,属接受风险)。
- **guest 的 worktree 被外部删掉**:WorktreePath 悬空 → 打开时 cwd 失效。低优,暂未做「worktree 缺失」检测+降级。
- owner-带-guest 三选项的第 3 项「保留其它」:guest 退回项目主目录、保留历史,语义已实现;UI 文案可再打磨。
