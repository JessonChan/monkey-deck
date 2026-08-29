# Review #28399 复审返工——P0 标签 OR 多选 / P1 闹钟配色定值 / P2 tooltip 静态化(#28401)

日期:2026-08-29
起因:#28400(2c20749)经 Review #28399 判 CHANGES REQUESTED——1×P0(#160③ OR 多选整体缺失,且 tags.mount.test test 4 反钉单选错误语义)+ 1×P1(#162 配色/圆角偏离规格定值,硬性断言零落地)+ 1×P2(#161 tooltip 动态化违反「保持静态」明文)。本条按 Findings 逐项返工。

## 改法(逐 Finding)

### P0:#160③ 标签过滤 OR 多选(commit 08a4eff)

- `Sidebar.tsx` state:`tagFilter: Record<string, string>` → `Record<string, string[]>`(无 key=未过滤,注释同步转英文)。
- `toggleTagFilter`:改集合增删——re-click 从选中集剔除,再点加入;**剔空即删 key 回未过滤**(不留空数组 key,杜绝「空集仍走过滤分支」)。
- `projectList` 管线:`(s.tags ?? []).includes(activeTag)` → `(s.tags ?? []).some(t => activeTags.includes(t))`(交集非空即命中,OR);`activeTags.length` 为 0 时不过滤;空 list 提示与「加载更多」门(原 `activeTag`/`!activeTag`,Sidebar.tsx:1000/:1003——返工中实测补上的两处遗漏引用)随 `activeTags.length` 同步。
- chip 渲染:`.active` class 与 tooltip(tagFilterActive/tagFilterIdle)从 `activeTag === tag` 改成员判断 `activeTags.includes(tag)`。
- 测试(tags.mount.test):
  - test 4 重写:单选断言 → OR 断言——选 api→仅 api 载体可见;加选 db→api∪db 载体均可见、仅持 redis 者隐藏;re-click api→仅剩 db 过滤;再点 db→空集抬过滤全量回;两 chip 均 `.active`、tooltip 按成员判断逐字断言。
  - 补复审缺口①:chip 行渲染项目**全部标签并集**(api/db/redis 三 chip 全在,非单 session 子集)。
  - 补复审缺口②:test 7 新增——面板开着时经 ctx 子菜单给 s2 赋新标签 db,父端乐观更新回流(root.render 新 props)后 **chip 行即时多出 db chip**、且新 chip 立即可过滤(s1 隐/s2 显),无需重开面板。
  - test 6 扩展:fixture 加第二枚标签(api+db 双激活),断言关面板丢弃**整个**选中集、重开无残留 active。
  - 文件头契约清单同步改 OR 语义。
- 触及区中文注释顺转英文(§3.7::169/:431/:493/:768 四处)。

### P1:#162 闹钟配色回定值(commit bc28aa8)

- `index.css` `.scheduled-indicator`:`background: rgba(255,214,10,0.16)` → **`0.12`**;`border-radius: 3px` → **`50%`**(回圆形);`color: var(--amber)`、14px 盒/10px 字形、`is-due-soon` perm-pulse 1.1s 均不动。
- 注释同步:删「the 3px-square silhouette」旧表述,改记 #162 定值与「14px 固定几何 = 行高不变量」。
- 断言落地(scheduled.mount.test 新增 test):**先探针实证 happy-dom 行为**——类规则只有样式表进文档才被解析,故测试把**真实 index.css 注入 `<style>`** 后对活跃 chip 走 `getComputedStyle`:color(var(--amber) 解析,#ffd60a/rgb 两种形态都收)、background 逐字 `rgba(255, 214, 10, 0.12)`、radius `50%`、width/height `14px`(行高不变量载体)、svg 10px。断言读的是出货 CSS 本体,无 fixture 复写值;测毕 `style.remove()` 不污染他测。

### P2:#161 tooltip 回静态(commit 424b91d)

- `Sidebar.tsx`:删 `projAllSelected` 派生态,select-all 按钮 tooltip 固定 `t("sidebar.batchSelectAll")`(「全选本项目会话」)。
- zh/en locales:删 `batchDeselectAll` key(clean cutover,两侧同步,locales.test 过)。

### P3 顺带

- worklog 文件名:按规格改为 `2026-08-29-sidebar-tags-realign-160-162.md`(git mv)。
- batch.mount.test 补「select-all 不碰 anchor」序列(#155④ 回归岗):Cmd+click s2 立锚→全选→Shift+click s3 仍按锚扩 range(全部保持 checked、count 3);若 anchor 被清,shift-click 退化为 toggle、s3 翻 false 即暴露。
- 触及区中文注释转英文(见 P0)。

## 判断与 OPEN

- **i18n「视图标题」key**:复审示意规格 i18n 硬性测试括号里提到视图标题 key,实现是纯 chip 行无标题,复审意见「向规格 owner 确认补 key,否则视为括号示例性描述」。本次自治运行无规格 owner 可问,**按示例性描述处理(未加标题 key)**;OPEN——若规格 owner 确需,补 key 属小改。
- **P1 断言机制**:复审建议「getComputedStyle 断言」,已照办;前置探针证实 happy-dom 不注入样式表时类规则不解析,注入真实 index.css 后完全可解析(0.16/3px 旧值在探针中原样复现,证明断言敏感)。
- **三端人工回归未跑**:本 agent 无 GUI 宿主,验证口径与被审 commit 一致(bun test 全量 + build);GUI webview / 远程浏览器 / PWA 真机回归留待有人环境,OPEN。改动均为既有组件内的状态/样式/文案修正,无新依赖、无布局结构变化,回归风险低。

## 验证(本机实证)

- `bun install` + `wails3 generate bindings`(worktree 重检出后 node_modules/bindings 均缺,同复审所遇)。
- 定向:tags 7 pass / scheduled 7 pass / batch 14 pass(28 pass / 0 fail)。
- 全量:`bun test --isolate` **430 pass / 0 fail / 7478 expects**(57 文件)。
- `bun run build`(tsc + vite)0 错误(仅既有 chunk>500kB 警告)。

## 改动文件

- `frontend/src/components/Sidebar.tsx`(P0 状态/管线/渲染 + P2 tooltip)
- `frontend/src/components/Sidebar.tags.mount.test.tsx`(P0 重写+补测)
- `frontend/src/index.css`(P1 定值+注释)
- `frontend/src/components/Sidebar.scheduled.mount.test.tsx`(P1 计算样式断言)
- `frontend/src/i18n/locales/zh.json` / `en.json`(P2 删 key)
- `frontend/src/components/Sidebar.batch.mount.test.tsx`(P3 anchor 序列)
- `docs/worklog/`(本条 + 旧条改名)

## 下一步

- 复审侧重验:三件硬性 mount 测试 + 全量 gate;P0 重点看 test 4 OR 断言与 test 7 即时反映。
- 规格 owner 裁「视图标题」key 是否需要(OPEN)。
- 有人环境补三端人工回归(OPEN)。
