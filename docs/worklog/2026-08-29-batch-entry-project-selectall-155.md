# #155 批量选择入口迁移 + 项目级一键全选(任务 #27991)

日期:2026-08-29 · 基线:rak main=7d50c58(#150/#152 链已在库,未动 internal/)

## 起因

GitHub #155:批量选择入口目前挂在 sidebar-header(ListChecks 按钮),语义是全局开关,与「批量选择是以项目为单位挑 session」的真实使用方式脱节。需求两点:

1. 入口从 header 迁到项目行按钮组(搜索旁)。
2. 新增「全选本项目」:一次把该项目当前可见 session 纳入选择集并进入选择模式。

约束(父任务规格 ③④):选择集为空时入口禁用或 no-op 不报错;不动 Shift 延伸 / modifier 点击 / 批量操作条 / 点击序 anchor 既有语义。

## 改法

### 入口迁移(frontend/src/components/Sidebar.tsx)

- 删除 sidebar-header 的 `batch-select-mode` 按钮(ListChecks,`batch-on` 高亮态)。
- 项目行按钮组(search 与 new-session 之间)新增同形制入口:`icon-btn small` + `ListChecks size=13`,与组内既有按钮(search=12/plus=13)一致;`data-testid="select-all-sessions-<projectId>"`(照 `search-sessions-<pid>` 命名式);tooltip 键 `sidebar.batchSelectAll`(en "Select all sessions in this project" / zh "全选本项目会话")。

### 全选语义(新增 `selectAllProject(pId)`,置于 `projectList` 之后)

- **「可见」= `projectList(pId)`**——与键盘导航(#101)、Shift+click 范围数学(#94)共用的同一渲染数组:搜索/标签过滤生效态即过滤结果集(该状态下分页自动绕过),未过滤态即分页切片。这是规格「当前可见 session(搜索/过滤生效态下即过滤结果集)」的直接读法,且验收「过滤态全选仅含可见项且批量操作条计数=可见数」逐字成立。
- **anchor 不碰(④)**:`selectAllProject` 不写 `selAnchorRef`——select-all 不是单行 toggle 点击,不伪造「最后单独点击行」;既有 Shift/modifier/anchor 路径零改动(205 行区块仅注释同步了入口描述)。
- **union 语义**:并入既有 `sel` Set,跨项目、跨次调用可叠加;死 id 剔除 effect、batch-bar 计数、copy/delete 全部复用,零新增状态。
- **折叠项目自动展开**(`if (!expanded.has(pId)) setExpanded(...)`)——使规格「进入选择模式(checkbox 可见)」字面成立;先例是紧邻的搜索按钮(`toggleSearch` 同样自动展开)。
- **空选择集 no-op(③)**:`projectList(pId).length === 0` 直接 return,不进选择模式、不弹 batch-bar、不报错(空项目/过滤到零都覆盖)。规格允许「禁用或 no-op」二选一,取 no-op:原生 `disabled` 会吞掉 hover 事件导致 tooltip(§4.5)失效,且 `.icon-btn` 无 disabled 样式还得加 CSS;no-op 零 CSS 改动、tooltip 常活。

### Clean cutover

- 删除死 CSS `.icon-btn.batch-on` 两条规则(frontend/src/index.css,仅 header 旧按钮引用)。
- 删除 i18n 死键 `sidebar.batchSelectOff` / `sidebar.batchSelectOn`(en/zh,仅旧 header 按钮引用),原位替换为 `batchSelectAll`。

### 测试(frontend/src/components/Sidebar.batch.mount.test.tsx)

- i18n mock 升级为插值回显(tags 测试先例),计数断言可钉死数值(如 `sidebar.batchCount {"count":2}`)。
- `sess` fixture 增加 `tags` 参数;`mounted()` 增加 `sessionsByProject` 覆盖参数;顺手删除因此失去调用方的裸 `mount()` helper。
- 既有 6 项中 2 项(header 按钮进入选择模式 / checkbox 驱动计数)迁移到新入口,语义不变(Esc 退出清空、空选隐藏操作条);4 项新增:
  1. 过滤态(tag filter)全选只含过滤结果、计数=可见数,解除过滤后被隐藏项未被选中;
  2. 跨项目 union(p1 全选 + p2 全选 = 4);
  3. 折叠项目全选自动展开、checkbox 落地,他项目不误选;
  4. 空项目全选 no-op(无选择/无模式/无操作条/不崩)。

## 改了哪些文件

- `frontend/src/components/Sidebar.tsx` —— 入口迁移 + `selectAllProject` + 注释同步
- `frontend/src/index.css` —— 删死 CSS `.batch-on`
- `frontend/src/i18n/locales/{en,zh}.json` —— 键替换 `batchSelectOn/Off` → `batchSelectAll`
- `frontend/src/components/Sidebar.batch.mount.test.tsx` —— 迁移 2 项 + 新增 4 项 + mock/fixture 升级

## 验证

- `bun test --isolate`(frontend 全量):**408 pass / 0 fail**(批量套件 10 项全绿)。首次运行有 4 个 `Cannot find module .../bindings/...` 失败,系新 worktree 缺 Wails 生成物,`wails3 generate bindings` 后消除(bindings 不入库,环境性,与本改动无关)。
- `bun run build`(tsc + vite production):零错误(仅既存 chunk-size advisory warning)。
- Go gate:`go build ./...` rc=0、`go vet ./...` rc=0、`go test -short ./...` rc=0(15 包 ok,无 FAIL;链接期 macOS SDK 版本 warning 为环境噪音)。本次零 Go 改动,gate 不破。
- 三端说明(§4.7):本次为纯前端 Sidebar 交互,零新增样式(新按钮完全复用既有 `.icon-btn.small` 形制)、零新增后端面、无 `isRemoteClient()` 守卫分支、无 ≤768px 断点敏感结构,三端渲染面不存在分化点;行为面以 mount 测试(happy-dom 真实点击/断言)覆盖。本沙箱无法起 Wails GUI 做实机三端冒烟,已留待人工复核(见下一步)。

## OPEN / 下一步

- **大项目全选的边界(留评审裁量)**:未过滤态下全选取分页切片(当前可见),>25 个 session 的项目需「加载更多」后再点一次(union 可续选)。若评审裁定「全选」应为全项目全集(绕过分页),把 `selectAllProject` 里的 `projectList` 换成无切片的过滤集合即可(一行改动,已按规格「当前可见」字面实现,不擅自扩大)。
- 人工三端冒烟:桌面 GUI(hover tooltip 形态)、远程浏览器、PWA(≤768px 按钮组不换行)。
- 不 push,停 completed-ready 等人复核。
