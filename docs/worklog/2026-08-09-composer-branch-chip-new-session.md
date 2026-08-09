# 2026-08-09 Composer 分支 chip 点击 → 从该分支新建对话(Task #24202)

## 起因

Composer 顶部的「当前分支」chip 原本点击是**复制分支名**。更顺手的语义是:点当前分支
→ 直接从它 fork 一个新 worktree 开新对话(对应「以当前会话的成果为基线再开一条线」)。
复制分支名是低频操作(侧栏右键菜单 / GitPanel 已能复制路径),让 chip 承担「从此分支
新建」更符合 chip 的「身份即入口」语义。

## 改法

数据流:`Composer 分支 chip` → `onNewSessionOnBranch(branch)` →(经 ChatView 透传)→
`App.onNewSessionOnBranch` → `createSession(undefined, branch)` → `setNewSession({
..., initialBaseRef: branch })` → `NewSessionModal initialBaseRef`。

1. **NewSessionModal 加 `initialBaseRef?: string`**:非空时把 `mode` 初值设为 `"new"`、
   `baseRef` 初值设为该值 —— 弹窗一打开就停在「新建独立 worktree」基线选择器、基线已填好,
   跳过手动选 mode 这步。空则走原默认流程(null / "")。仅在 mount 时生效(弹窗每次都是
   新 mount,符合既有范式)。
2. **Composer**:加 `onNewSessionOnBranch: (branch) => void` prop;chip 的 `onClick` 从
   `copyBranch` 改为 `() => onNewSessionOnBranch(branch)`;删掉随之死掉的 `branchCopied`
   state / `copyBranch` / `copied` class / `Check` 切换图标 / `copyText` import。
3. **ChatView**:Props 加 `onNewSessionOnBranch` 并透传给 Composer(branch 旁)。
4. **App**:`newSession` state 类型加 `initialBaseRef: string`;`createSession` 加可选
   第二参 `initialBaseRef?: string` 透进 `setNewSession`(Sidebar 的 `onCreateSession(p.id)`
   单参调用不受影响);新增 `onNewSessionOnBranch` useCallback(依赖 `createSession`),
   用**当前选中项目**(`createSession(undefined, branch)` —— Composer 只为活动 session 渲染,
   活动 session 必属当前项目);ChatView 与 NewSessionModal 各加一行透传。
5. **tooltip 文案**:`composer.branchTip` 改为「点击从此分支新建对话」(en: "click to start
   a new chat from here");删掉已无引用的 `composer.branchCopied`。

## 改了哪些文件

- `frontend/src/components/NewSessionModal.tsx`(加 `initialBaseRef` prop + mode/baseRef 初值)
- `frontend/src/components/Composer.tsx`(加 `onNewSessionOnBranch` prop;chip onClick 改调;
  删 copy 死代码 + 无用 import)
- `frontend/src/components/ChatView.tsx`(Props + 透传)
- `frontend/src/App.tsx`(state 类型 / createSession 加参 / onNewSessionOnBranch callback /
  两处透传)
- `frontend/src/i18n/locales/{en,zh}.json`(branchTip 文案 + 删 branchCopied)

## 验证

- `wails3 generate bindings` 后 `bun run build`(tsc + vite)通过,0 类型错误。
- `bun run test`:177 pass / 5 fail。5 个 fail 全在 `NewSessionModal.mount.test.tsx`,断言
  形状还停在加 MCP 前的旧 `onConfirm` payload(缺 `mcpServerIDs`)—— 与本次改动无关的
  pre-existing(见 `2026-08-09-review-24189-mcp-css-classes-fe-acceptance.md`、
  `2026-08-04-chat-selection-virtualization-flow.md`)。本次未触碰 `onConfirm` payload 形状。
- 后端无改动(Go 未动)。

## 下一步

- 实测:需在 `wails3 dev` 里点 Composer 分支 chip 验证「弹窗打开即 mode=new、基线已填、
  Create 可直接点」(本环境无 GUI)。
- NewSessionModal 那 5 个 pre-existing fail 另案修(更新断言补 `mcpServerIDs: []`)。
