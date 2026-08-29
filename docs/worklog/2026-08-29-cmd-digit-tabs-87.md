# #28410 ⌘1-9 改切已开 tab:sessionsRef → openTabsRef(#87)

## 起因

#87:⌘/Ctrl+1-9 的语义错位。处理器(101f315 引入)读 `sessionsRef`——切的是「当前选中项目的侧栏 session 列表第 N 项」,与 TabBar 时代(多 tab、跨项目)的肌肉记忆冲突:数字序应该跟 tab 条显示序走,而不是侧栏列表序(用户按 ⌘2 期望切第 2 个 tab,实际却可能跳到一个根本没开 tab 的 session)。本卡落地父卡 #28409 定位的方案。

## 行为变更(唯一语义源:App.tsx ⌘1-9 effect)

| 维度 | 旧(列表语义) | 新(tab 语义) |
|---|---|---|
| 目标集 | `sessionsRef.current`(选中项目的侧栏列表) | `openTabsRef.current`(已开 tab,数组序 = TabBar 显示序) |
| 数字 N | 侧栏第 N 个 session | 第 N 个已开 tab |
| 越界 | 列表不足 N 个 → 静默 | 已开 tab 不足 N 个 → 静默(不变;注意侧栏可能有 60 个 session 而只开了 3 个 tab,⌘4 必须仍静默) |
| 选中即激活 | 打开 session | 不变:走同一 `openSession(target, projectIdOf(target))` 入口(与 TabBar tab 点击完全同路径),`selectedSessionId` 跟随 → TabBar 活动态随之 |
| popout | 不挂监听(no-op) | 不变(保留原注释语义) |

实现要点:
- `openTabsRef`(App.tsx 现成,closeTab 已在用)读最新 tab 序;effect 依赖从 `[isPopout, openSession]` 加到 `[isPopout, openSession, projectIdOf]`——projectIdOf 依赖 `sessionsByProject`,与 openSession 同步变化,不引入额外重订阅。
- 传 `projectIdOf(target)` 而非裸 `openSession(target)`:tab 可跨项目,数字切换要连选中项目一起切(openSession 内 `projectId !== selectedProjectId` 分支);这也是 closeTab 邻居兜底(`openSession(next, projectIdOf(next))`)的既有模式。
- **删掉死代码 `sessionsRef`**(声明 + 赋值,App.tsx 原 300-303):全仓唯一消费点就是这个 handler,切换后失去存在理由(§5.3 Less is More,删掉后功能不变的代码就该删)。

## 旧测试改写清单

**没有旧测试可改写**:101f315 引入 handler 时未带任何测试;全仓 grep(`key: "[1-9]"` / `sessionsRef` / digit keydown)确认无既有断言锚定旧列表语义。因此本卡新写的 mount 测试(4 条)就是新语义的第一份、也是唯一的回归防线,其中「越界忽略」一条显式钉住了新旧语义的分界(侧栏 60 个 session、只开 3 个 tab,⌘4/⌘9 必须静默——旧语义会切到 s4/s9)。

## 改动文件

- `frontend/src/App.tsx`:⌘1-9 handler 改读 `openTabsRef`,删除 `sessionsRef`,注释重写(英文,§3.7)
- `frontend/src/App.cmd-digit-tabs.mount.test.tsx`(新增):mount 真实 App,harness 同 App.tab-limit.mount.test.tsx(mock 后动态 import App——bun mock.module 拦截要求,文件头注明)

### 测试覆盖(全部走真实用户路径:tab 经 `chat:popout-changed` restore 打开、激活经 tab 真实 click、关闭经 × 按钮)

1. **3 tab ⌘2 切第 2 tab**:restore s1/s2/s3 → click 激活 s1 → ⌘2 → s2 活动态(TabBar `active` class)+ `OpenSession:s2` 调用 + `defaultPrevented=true`。
2. **越界忽略(新旧语义分界)**:侧栏 60 个 session 只开 3 tab,⌘4/⌘9 → 不 preventDefault、激活态不动、零 OpenSession 调用。
3. **关 tab 后序号重排(closeTab 邻居兼容)**:[s1,s2,s3] 关 s2(非激活、idle,无弹窗)→ 剩 [s1,s3] 且 s1 保持激活 → ⌘2 落到 s3。
4. **popout no-op**:`#popout=s1` 启动 → 只 boot 打开 s1、无 tabbar → ⌘2 不 preventDefault、不产生新 OpenSession。

## 验证

- `bun run test`(repo 脚本 = `bun test --isolate`):**440 pass / 0 fail**(60 文件)。⚠ 过程踩坑:直接 `bun test`(无 `--isolate`)时本测试文件的 `@wailsio/runtime` mock 泄漏进 clipboard/panel/coarse-pointer 等 4 个无关测试致假失败——隔离跑即全绿,与本次改动无关。
- `bun run build:dev`(tsc + vite):零类型错误,构建成功。
- 新测试单文件:`4 pass / 0 fail`。
- bindings 缺失踩坑:worktree 无 `frontend/bindings/`(gitignore 的生成物,`frontend/src/bindings` 是入库 symlink),`make bindings`(= `wails3 generate bindings -clean=true -ts -i`)补齐后测试可跑;与 v3.0.0-alpha2.106 版本锁一致。
- 范围:纯前端(App.tsx handler + 新测试),无 Go/binding/协议改动,无三端差异面(handler 是 window keydown,主窗口才挂;移动端 PWA/远程浏览器走同一前端代码,行为一致,不涉及布局/样式/组件结构,§4.7 三端矩阵中无新增差异格)。

## 下一步

- 无遗留。fe-review 通过后关 #87(父卡 #28409 全量规格中的本子项落地)。
