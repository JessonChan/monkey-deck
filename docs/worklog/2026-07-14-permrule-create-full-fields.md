# 2026-07-14 修复 PermissionSettings 创建规则缺必填字段(TS2345)

## 起因
`wails3 task build`(acceptance gate)前端 TS 编译报错:
- `frontend/src/components/PermissionSettings.tsx:70`:`CreatePermissionRule({ level: "ask", enabled: true, sortOrder: rules.length })`
  报 TS2345 —— 参数缺 `PermissionRule` 的必填字段(`id`/`toolName`/`actionType`/`pathPattern`/`commandPattern`/`createdAt`/`updatedAt`)。

## 根因
- `wails3 task build` 的 `generate:bindings` task 用 `-ts` 标志(`build/Taskfile.yml:191`),生成的是 `.ts` **interface**(`PermissionRule` 是 interface,不是 class)。
  - 上一条 worklog(`2026-07-14-fix-ts-build-attachment-permrule.md`)把 `new PermissionRule({...})` 改成对象字面量是对的(interface 不可 `new`),但当时漏掉了「对象字面量仍需满足 interface 全部必填字段」—— 那次验证用的是手跑 `wails3 generate bindings`(不带 `-ts`),生成的是 `.js` + JSDoc,字段缺省被构造器兜底,TS 不报错;而真实 build 走 `-ts` 生成严格 interface,缺字段即 TS2345。
  - 教训复述:验证前端 TS 必须用 `wails3 task build` 同款 `-ts` binding(`wails3 generate bindings -ts -i -clean=true`),不能只跑不带 `-ts` 的版本,否则 binding 形态不同、漏报。
- `CreatePermissionRule(rule: PermissionRule)` 形参是完整 interface,必须传全字段。

## 改法
- `PermissionSettings.tsx` 的 `add()` 里把对象字面量补齐为完整 `PermissionRule`:
  - `id: ""` —— 后端 `store.CreatePermissionRule`(`internal/store/permissions.go:50`)在 `r.ID == ""` 时自动 `uuid.NewString()` 生成。
  - `toolName/actionType/pathPattern/commandPattern: ""` —— 空约束 = 通配(§3.4,interface 注释亦明示「空约束字段 = 通配」),新建规则默认匹配全部。
  - `level: "ask"` —— interface 里 `level: string`(非联合/枚举),`"ask"` 直接可赋值,无需 `as`。
  - `sortOrder: rules.length` —— 保持原语义(放队尾);后端在 `SortOrder==0` 时也会兜底成 max+1,行为一致。
  - `createdAt/updatedAt: 0` —— 后端 `CreatePermissionRule` 用 `now()` 覆盖,前端给 0 占位即可。

## 改了哪些文件
- `frontend/src/components/PermissionSettings.tsx`(`add()` 补齐 `PermissionRule` 全字段)。
- `frontend/bindings/...` 由 `wails3 task build` 重新生成(gitignore,不入库)。

## 验证
- `wails3 generate bindings -ts -i -clean=true` 后 `frontend/` 下 `bunx tsc` 零错误(复现 TS2345 → 修复后消失)。
- acceptance gate 全绿:`mkdir -p frontend/dist && touch frontend/dist/.gitkeep && go build ./... && go vet ./... && go test ./... && wails3 task build` —— `wails3 task build` 重新生成 `-ts` binding、`tsc && vite build` 零 TS 错误、Go 二进制编译成功(go build/vet/test 仅 macOS 链接器版本告警,非错误)。
- `git status` 仅 `frontend/src/components/PermissionSettings.tsx` 改动,无 RAK 运行时文件 / AGENTS.md / bindings / dist 误入。

## 下一步
无;本次纯修 build,不涉及行为变更(新建规则仍默认 `ask` 档、空约束通配,与之前一致)。
