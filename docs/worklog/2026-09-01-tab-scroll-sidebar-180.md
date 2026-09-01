# #180 侧栏滚动到选中 tab session 行

- 日期:2026-09-01
- Issue:#180
- 任务:Task #28943(实现 #180)
- 分支:`agent/coder/50001ba2`(基于 main `af04815`)
- 改动:`9eae644 feat(frontend): sidebar auto-scrolls to selected tab session row (#180)`

## 起因

选中 session 的方式不只有点侧栏行:tab 栏切 tab(#156 体系)、⌘数字、恢复上次选中都会改
`selectedSessionId`,此时侧栏可能正停在别的滚动位置,甚至目标行还在分页切片之外——用户点
了 tab,却看不到侧栏里对应的行高亮在哪。#180 要求侧栏自动把选中行滚进视野。

## 行为设计(与任务验收逐条对应)

新增一个 effect(`frontend/src/components/Sidebar.tsx`,紧跟 694-698 行 kbd 光标滚动先例之后):

1. **监听 `props.selectedSessionId`,含首挂载**:`useEffect` deps =
   `[props.selectedSessionId, scrollTick]`,mount 时照常执行一次。
2. **以实际 DOM 定位行**:两个渲染分支(重命名分支/普通分支)的 `.session-item-row` div
   本就带 `data-testid="session-<id>"`,effect 直接
   `rootRef.current?.querySelector('[data-testid="session-<id>"]')`——**没有新增
   `session-item-row-<id>` testid**(任务里是"可补"项;现有 testid 已精确定位两分支,
   加第二个属冗余,Less is More)。行找到 → `scrollIntoView({ block: "nearest" })`,
   与 kbd 先例同参数。
3. **跨分页先加载后滚**:行不在 DOM 时按序守卫——
   - 全列表(`props.sessionsByProject`)里没有该 id → 直接返回,**零翻页**;
   - 行所属项目未展开 → 返回(展开翻页也渲染不出来,只会白转;折叠属"行不可寻"静默 no-op);
   - 该项目有搜索或标签过滤激活 → 返回(过滤态下 `projectList` 绕过切片,翻页无效)——
     与 loadMore 按钮自身的渲染条件(`!searching && activeTags.length===0 && hiddenCount>0`)
     完全对齐;
   - `hiddenCount>0` → **每个 effect tick 至多翻一页**:`setSessionLimit` 用与 1072 行
     loadMore 按钮逐字相同的增量公式,并 `setScrollTick(n+1)` 让 effect 重跑,直到行出现
     或 `hiddenCount` 耗尽。hiddenCount 单调递减有上界,无死循环。
4. **已可见行零翻页直接滚;不可寻不滚不报错**:找到行即滚并 return;所有守卫路径都是静默
   no-op,零 throw。

辅助:`rootRef`(挂 `<aside>`)把 DOM 查询限定在本组件子树内;`scrollTick` 是新独立
state,分页状态结构 `sessionLimit: Record<string, number>` 未动。

## 红线核对

- kbd 光标滚动(695-701 行)零改动(diff 里仅作上下文出现)。
- 手动 loadMore 按钮、分页状态结构零改动(只复用其增量公式与可见性守卫)。
- TabBar + `TAB_LIMIT`(#156)零触碰;**App.tsx 零改动**(`selectedSessionId` prop 本就存在)。
- 零后端;无新增 i18n key / CSS。

## 测试

`frontend/src/components/Sidebar.tab-scroll.mount.test.tsx`(与既有 Sidebar mount 测试同一
mock 脚手架;`scrollIntoView` 用 `Element.prototype` 记录式 spy,happy-dom 原生实现是
no-op):

1. 选中第 2 页 session(s30,共 60 条):自动翻一页后目标行出现在 DOM(且恰好一页——s55
   仍不可见、loadMore 按钮仍在),`scrollIntoView` 恰调一次、参数 `{block:"nearest"}`、
   接收者就是目标行元素。
2. 已可见行(s3):直接滚,恰调一次;零翻页(第 2 页行不出现)。
3. 全列表无此 id("ghost"):零 scroll 调用、零翻页(仍恰 25 行)、零报错。

## 验证

- `bun test components/Sidebar.tab-scroll.mount.test.tsx` → 3 pass / 0 fail。
- `bun test --isolate`(仓库配置的全量跑法,package.json `test` script)→ **535 pass / 0 fail**
  (含本任务新增 3 条)。
- `npx tsc` → 0 error(测试目录在 tsc 范围内)。
- `npm run build`(tsc + vite build)→ 成功(chunk >500kB 警告为存量提示,与本次无关)。
- 改动面确认:`git diff` 仅 Sidebar.tsx 三个 hunk(ref 声明 / effect / aside ref)+ 新测试文件。

## 环境踩坑(续跑记录,非代码问题)

- 本 worktree 曾被重置到 `af04815`,丢了两样**不入库**的产物:`node_modules` 与
  `frontend/bindings/`(`.gitignore` 排除的 Wails 生成物)。恢复:`bun install` +
  `make bindings`(Makefile 钉版 `wails3 generate bindings -clean=true -ts -i`;裸
  `wails3 gen bindings` 在 PATH 上的 CLI 里不是子命令,且钉版是 §0.5 硬要求)。
- bindings 缺失时全量套件会出现 11 个失败(挂真实组件 import bindings 的用例)、tsc 报
  一片 `TS2307`——都是同一环境根因,生成后全消。
- `bun test` 不带 `--isolate` 会让 74 个文件同进程互踩 `globalThis.window`,出现百级假
  失败;必须用仓库 script 的 `bun test --isolate`。

## 下一步 / OPEN

- 无。等 review;不 push、不关 issue(按任务流程)。
