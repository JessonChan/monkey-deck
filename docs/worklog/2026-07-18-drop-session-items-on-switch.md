# 2026-07-18 切走丢弃:空闲 session 切走时回收 items 缓存

## 起因
排查 monkey-deck WebKit WebContent 进程内存(实测 PID 74658):新启动 747MB,
**开几个 session 后涨到 892MB(+145MB),peak 冲到 1.4GB**。关闭/切回都不回落。

`heap` 工具分解(658302 个分配,~345MB 可统计):
- 可分类部分(~10MB)全是 WebCore 渲染对象:`InsertInto/DeleteFromTextNodeCommand`
  (流式文本变更)、`RenderBlockFlow`/`RenderFlexibleBox`(渲染树)、`LegacyRenderSVGPath`/
  `CGPath`(lucide 图标)、`WebCore::Text` —— 形态 = "大量消息 DOM + 大量图标 + 流式文本 churn"。
- **351MB 的 `non-object` 大块** = bmalloc 堆(JS 对象 / React fiber / ChatItem / AST),
  `heap` 进不去(WebKit 用 bmalloc 不是 libmalloc),要精确拆需 Web Inspector 拍快照。

**两层数据**:
- Layer 1 = WebKit 不主动还页(高水位 plateau,所有 WebKit app 通病,app 改不了);
- Layer 2 = `itemsBySession` 累积(开过的 session 全留,GC 收不掉,我们能改)。

本次治 Layer 2。

## 根因(为什么是 itemsBySession,不是别的)
`App.tsx` 的 `itemsBySession: Record<string, ChatItem[]>` 每个开过的 session 都留一份
完整 ChatItem[](含消息正文 + 工具 JSON),切 session 只追加不删。最大 session 614 条 /
4.3MB content,渲染后 DOM + markdown AST 是源文本数倍。这是"多 session 内存累积"的真因,
和 `heap` 看到的 WebCore 渲染对象堆积吻合。

这是 `docs/worklog/2026-07-02-content-visibility-render-opt.md:30` 早就写下的预案:
> 若未来用户多 session 切换导致内存累积,再评估**非活跃 session 回收**。

触发条件本次由实测确认 → 执行预案。

## 改法
`openSession`(App.tsx,所有切换的唯一咽喉)开头:从 `oldSession` 切到 `newSession` 时,
若 `oldSession` 空闲(非 prompting),丢掉 old 的 `itemsBySession` / `hasMoreBySession`,
并清 `loadedSessionsRef` 守卫(否则切回守卫通过但数据空 → 显示错乱)。

切回时 `loadedSessionsRef` 已删 → 走已有的 `LoadMessagesPage` 重载分支
(`idx_messages_session` 索引,毫秒级)。滚动位置在 `ChatView.scrollStateRef`
(按 sessionId 记忆,与 itemsBySession 解耦),不丢。composer 状态
(draft / history / attachments / mentions / images / queue)本就"切走保留",不动。

### 安全不变量:prompting session 绝不丢
prompting(流式回合进行中)的 session 切走时,**SessionUpdate 事件还在往
`itemsBySession[old]` 灌**(App.tsx:181,按 `ev.sessionId` 入缓存,不过滤选中)。
此时丢缓存 = 丢流式内容。判定抽成纯谓词 `shouldDropOnSwitch`(`lib/sessionDrop.ts`),
单测锁住(6 用例):prompting 保护 / 无旧 session 不丢 / 同 session 不丢 /
idle|empty|error 可丢 / 未知状态默认可丢(防未来新状态意外变"永不释放")。

## 改了哪些文件
- `frontend/src/App.tsx`:openSession 开头加切走丢弃块(+ `shouldDropOnSwitch` import)。
- `frontend/src/lib/sessionDrop.ts`(新):`shouldDropOnSwitch` 纯谓词。
- `frontend/src/lib/sessionDrop.test.ts`(新):6 用例锁安全不变量。

## 验证
- `cd frontend && npx tsc --noEmit`:通过(exit 0)。
- `cd frontend && bun test`:40 pass / 0 fail(原 34 + 新 6)。
- 切换链路 trace(idle A→B→A):loadedSessionsRef 删除/重建正确,A 切回从 DB 重载,数据完整。
- 边界:首次打开(无 old)/ 同 session / 切到 prompting session,谓词均正确不丢。
- **内存效果与 UX(切回重载的 flash)由用户在分支上手动跑验证**——这是本分支存在的目的。

## 分支
`feat/drop-session-items-on-switch`(用户要求隔离测试,不污染 main)。
验证效果满意再合 main;效果不好可直接弃分支。

## 下一步(显式不做 / 留待评估)
- **切走后才结束的 session 回收**:session 在用户切走后才 prompting→idle 的情况下,
  本次实现会把它保留到用户下次再访问并切走才回收。最坏情况 = 并行活跃 session 数,
  属合理 bound;若实测发现累积明显,再加"status 事件检测到 idle 且非选中 → 丢"的 effect。
- **每次切换都重载的 flash**:本次为最简实现,每次切回都从 DB 重载(含 markdown 重渲染)。
  大 session 可能感知到 100ms 级延迟。若 UX 不可接受,再评估 LRU(保留最近 N 个 session 缓存)。
- **终端 registry 回收**:同种"开过即留"的累积,本期不动(和"切回见历史/后台进程不死"
  的 UX 有张力,需另定回收策略)。
- **Web Inspector 拍 JS 堆快照**:要精确拆 351MB bmalloc 堆里 ChatItem / fiber / AST
  各占多少,需 `wails3 dev` 模式(WKWebView 开 inspector)+ Safari Develop 菜单。
  本轮靠 `heap` 的 C++ 层 + 模型推理已够定位,未做。

## 关联
- 预案出处:`docs/worklog/2026-07-02-content-visibility-render-opt.md:30`
- 终端内存(同期另一条线):`docs/worklog/2026-07-17-terminal-scrollback-shrink.md`
- 虚拟化不做(两次失败的项目决策):`docs/worklog/2026-07-02-content-visibility-render-opt.md` +
  `docs/worklog/2026-07-14-fix-scroll-jank-reflow-compositor.md`
