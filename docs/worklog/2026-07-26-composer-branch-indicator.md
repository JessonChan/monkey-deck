# 2026-07-26 前端 Composer compose-tools 加当前 git 分支指示(GitBranch + 分支名 + tooltip)

**类型**:feat(frontend)

## 起因

Task #23074。Composer 的 compose-tools 已有附件 / 图片 / 斜杠 / 翻历史 chip,但缺「当前 session 工作目录所在的 git 分支」这一关键上下文指示。用户在对话时常常不知道当前 turn 改的是哪条分支(worktree 模式 = `md/<id>`,非 worktree git 项目 = 项目目录当前分支),要切到右侧 GitPanel 才能看。

App 层早已有 `branchBySession`(state,`SessionCurrentBranch` 拉取,源代码管理面板用),且 `SidePanel` 也已用同一算式 `branchBySession[selectedSessionId] || activeSession?.branch || ""`。本任务把这条算式接到 Composer,让分支在输入区就近可见。

## 改法

### 1. Composer 加 `branch` prop(Composer.tsx)

- `Props` 接口新增 `branch: string`(注释:空 = 非 git / 未取到 → 不显示)。
- 解构参数加 `branch`。
- `import { ..., GitBranch } from "lucide-react"`(与 GitPanel / SidePanel 同图标,形态一致)。
- 在 `compose-tools` 末尾(history chip 之后)渲染只读 chip:
  ```tsx
  {branch && (
    <span className="compose-branch" data-testid="composer-branch"
          data-tooltip-id="md-tip" data-tooltip-content={t("composer.branchTip")} data-tooltip-place="top">
      <GitBranch size={11} />
      <span className="compose-branch-name">{branch}</span>
    </span>
  )}
  ```
  - **空不渲染**(`{branch && ...}`),不占位。
  - **只读**(`<span>`,非 `<button>`):分支是上下文指示,不可点改。
  - **统一 react-tooltip**(§4.5):`data-tooltip-id="md-tip"` + `data-tooltip-content` + `data-tooltip-place="top"`,与同区的 `compose-history-chip` / `ComposerUsage` 同族,禁原生 `title`。
  - **不裸露字段名**(§4.4):tooltip 文案是人话「本对话工作目录当前所在的 git 分支」,不是 `cwd branch:`。

### 2. ChatView 透传(ChatView.tsx)

`Props` 新增 `branch: string`,在 `<Composer>` 调用处加 `branch={props.branch}`。

### 3. App 传算式(App.tsx)

`<ChatView>` 调用处新增:
```tsx
branch={branchBySession[selectedSessionId] || activeSession?.branch || ""}
```
与同文件 SidePanel 那条(line 1364)完全一致 —— 同一算式两处用,保持单一来源(`branchBySession` 优先,空再回退 `activeSession.branch`,后者 worktree 模式有值但非 worktree git 项目为空,故必须先查 `branchBySession`)。

注:ChatView 渲染处(line 1270)只校验 `selectedSessionId`,不校验 `activeSession`,故用 `activeSession?.branch` 安全访问(与 line 1196 `termCwdRef` 同模式);SidePanel 渲染处(line 1357)已校验 `selectedSessionId && activeSession`,故用 `activeSession.branch`。

### 4. i18n(en.json / zh.json)

`composer.branchTip`:
- en: `"Current git branch of this chat's working directory"`
- zh: `"本对话工作目录当前所在的 git 分支"`

### 5. CSS(index.css)

新增 `.compose-branch`(只读 chip)与 `.compose-branch-name`(ellipsis 截断):
- 视觉与 `.compose-history-chip` 同族(mono 10.5px + `--elev-2` 底 + `--sep` 边 + 20px 高 + `margin-left: 4px`),但不可点 → 用 `--text-3` 默认色、默认光标(无 hover 高亮、无 transition)。
- `max-width: 180px` + 内层 `.compose-branch-name` `overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`,长分支名(如 `feature/very-long-branch-name-123`)不撑爆 compose-tools。

## 改了哪些文件

- `frontend/src/components/Composer.tsx`(import GitBranch / Props.branch / 解构 / 渲染)
- `frontend/src/components/ChatView.tsx`(Props.branch / 透传)
- `frontend/src/App.tsx`(ChatView 调用处传 branch 算式)
- `frontend/src/i18n/locales/en.json` / `zh.json`(composer.branchTip)
- `frontend/src/index.css`(.compose-branch / .compose-branch-name)
- `frontend/src/components/Composer.mount.test.tsx`(STUB_PROPS 加 `branch: ""`)
- `frontend/src/components/ChatView.virtual.mount.test.tsx`(baseProps 加 `branch: ""`)
- `frontend/src/components/TurnDivider.duration.mount.test.tsx`(baseProps 加 `branch: ""`)

## 验证

- `wails3 generate bindings`(本 worktree 缺 generated bindings,先生成)。
- `cd frontend && bun run build`:tsc + vite build 全绿(无类型错误)。
- `cd frontend && bun run test`:130 pass / 0 fail(含 Composer / ChatView 虚拟化 / TurnDivider 三处 mount 测试)。
- `go build ./...` + `go vet ./...`:clean(本任务未改 Go,只是确认整树仍可编)。

## 下一步

- 可选增强:分支名点击跳转到 SidePanel 的 SCM tab(目前是只读指示)。
- 可选增强:worktree 模式下分支名加视觉区分(如 `md/` 前缀用 dim 色),与非 worktree 项目分支区分。
