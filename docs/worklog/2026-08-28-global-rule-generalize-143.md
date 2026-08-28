# 全局允许规则泛化:read basename + 弹窗明示 + 存量迁移(#143)

日期:2026-08-28
状态:完成(代码 + 单测 + 浏览器实证)
关联:父 issue #27970(规格)、#143

## 起因

「全局允许」(权限弹窗 onRespond("global"))把当前请求固化成一条 `level=allow` 的
「准确匹配」规则(`permissions.ExactMatchRule`)。旧实现对 read 类请求固化的是
**首个 location 的绝对路径**——「在这个项目读过一次 `notes.md`,换个项目再读同名文件
又要弹一次」,对无副作用的读操作过于保守;write/exec 的精确语义则是对的。同时弹窗
只显示「全局允许」按钮,不说明**会记住什么**,用户对规则的实际形状没有预期;设置页
规则列表也看不出一条规则是「命令原文/文件名/精确路径」哪种形态。

## 改法

### ① ExactMatchRule 按动作分叉(`internal/permissions/permissions.go`)

- **read**(ActionOfKind 归 read 的 kind:read/search/think/fetch):无命令有路径时
  `PathPattern = filepath.Base(Locations[0])`——引擎 `matchPath` 对无 `/` 的 pattern
  本就按「全路径或 basename」匹配,**引擎零改动**。
- **write/edit/other**:保持 `Locations[0]` 绝对路径精确(写有副作用,跨项目同名不得误放行)。
- **exec 命令全文全等分支一字未动**(`^QuoteMeta(cmd)$`)。
- 多 location 仍取首个(单条 glob 无法表达集合,首个是最佳近似,原注释保留语义)。

### ② 弹窗按动作明示(`frontend/src/components/ChatView.tsx` PermissionCard)

全局允许按钮上方新增一行 hint(纯展示,`data-testid="perm-global-hint"` +
`perm-global-preview`):

| 动作 | 文案(key) | 预览值 |
|---|---|---|
| exec(有 command) | `chat.permGlobalHintExec` 按命令原文精确记忆 | prompt.command(后端已从 ToolCall RawInput 提取) |
| read | `chat.permGlobalHintRead` 按文件名记忆,任意目录同名放行 | basename(locations[0]) |
| write | `chat.permGlobalHintWrite` 按精确路径记忆 | locations[0] |
| 兜底 | `chat.permGlobalHintGeneric` 按当前工具与动作记忆 | 无 |

分支顺序与后端 ExactMatchRule 一致(命令优先);决策上下文取不到 → 通用文案。
新增 key 双语进 `en.json` + `zh.json`,过 `locales.test`。

### ③ 设置页规则形状标源(`frontend/src/components/PermissionSettings.tsx`)

RuleRow 首行渲染形状徽章(纯展示,带 §4.5 tooltip):

- 命令原文:`commandPattern` 形如 `^…$`(len>2)→ `settings.perm.shapeCommand`
- 文件名:`pathPattern` 无 `/` → `shapeFilename`
- 精确路径:`pathPattern` 含 `/` 且无 `*?[` → `shapePath`
- 其余(通配、自写 glob)不标。

### ④ 幂等迁移(`internal/store/migrations/0020_permission_read_basename.sql`)

存量改写:`level='allow' AND action_type='read' AND command_pattern='' AND
path_pattern LIKE '%/%' AND NOT LIKE '%/' 且无 glob 元字符` → 改写为 basename
(纯 SQLite 内建函数:`substr(p, length(rtrim(p, replace(p,'/','')))+1)`)。

守卫(每条都有明确理由):
- `command_pattern=''`:exec 规则带命令约束,不动(spec「exec/write 不动」);
- 非 allow 不动(spec 字面);
- 尾随 `/` 排除:会产生空 basename = 通配放行,危险;
- 含 `*?[` 排除:自写 glob 是用户手工规则而非全局允许产物,改写成 basename 会
  **静默扩大语义**(如 `docs/*.md` → `*.md`),超出「存量迁移」授权范围——这是对
  spec「PathPattern 含 / 改写 basename」的收窄解读,记录在案。

幂等:改写后 pattern 不含 `/`,WHERE 不再命中,重放为 no-op(测试断言二次执行)。
`updated_at` 一并刷新(语义变了,时间戳如实反映)。

## 改了哪些文件

- `internal/permissions/permissions.go`:ExactMatchRule read 分支 + 注释英化(§3.7 触及即转)
- `internal/permissions/permissions_test.go`:形状用例 3 新(read basename/纯名/多 location)、
  硬性三场景、exec `-s` 变体
- `internal/acp/handler_global_test.go`:FS 形状测试表驱动化(+read kind 端到端形状)
- `internal/store/migrations/0020_permission_read_basename.sql`:新迁移
- `internal/store/migrations_test.go`:迁移回放测试(7 种形状 + 幂等)
- `frontend/src/components/ChatView.tsx`:PermissionCard hint + baseName helper
- `frontend/src/components/PermissionSettings.tsx`:形状徽章
- `frontend/src/components/ChatView.permission-hint.mount.test.tsx`:新挂载测试 ×4
- `frontend/src/i18n/locales/{en,zh}.json`:`permGlobalHint*` ×4 + `settings.perm.shape*` ×6
- `frontend/src/index.css`:`.permission-global-hint` + `.perm-shape`

## 提交

- `d72b116` feat(permissions): read 全局允许泛化为 basename,write 保持绝对路径精确(#143)
- `1f3c754` feat(migrations): 0020 存量 read allow 规则改写 basename,幂等(#143)
- `3d058fb` feat(frontend): 权限弹窗按动作明示全局允许记忆内容+设置页规则形状标源(#143)
- 本条 worklog(docs 与代码分开提交,§6.2)

基于 main = `bba6867`,未 push。

## 迁移备查:真实库 permission_rules 全表 dump

开发验证时 dump(只读查询,`~/Library/Application Support/Monkey Deck/monkey-deck.db`,
schema_version=19,即 0019 为止):

```
id                                    tool     action  path  cmd                                                                                                                                                                                                                                                                                                                                                                                                                                level  so  enabled  created              updated
------------------------------------  -------  ------  ----  ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------  -----  --  -------  -------------------  -------------------
default-deny-dangerous                         exec          (?i)\brm\s+-\w*r\w*f|\brm\s+-\w*f\w*r|:\s*\(\)\s*\{\s*:\|:&\s*\};|mkfs\b|dd\s+.*of=/dev/|>\s*/dev/sd                                                                                                                                                                                                                                                                                                                               deny   0   1        2026-07-14 09:26:07  2026-07-14 09:26:07
default-allow-read                             read                                                                                                                                                                                                                                                                                                                                                                                                                                             allow  1   1        2026-07-14 09:26:07  2026-07-14 09:26:07
default-ask-write                              write                                                                                                                                                                                                                                                                                                                                                                                                                                            ask    2   1        2026-07-14 09:26:07  2026-07-14 09:26:07
default-ask-exec                               exec                                                                                                                                                                                                                                                                                                                                                                                                                                             ask    3   1        2026-07-14 09:26:07  2026-07-14 09:26:07
5502d9f1-…(×5 条 exec allow)               execute  exec          ^cd /Users/… && git status…$ 等 5 条 ^…$ 命令原文                                                                                                                                                                                                                                                                                                                                                                                  allow  4-8 1        2026-07-25 ~ 2026-08-28
```

**结论:该库 0 条「read+allow+含 / 路径」行 → 0020 在真实库上为 no-op**(历史全局
允许只出过 exec 规则;read 类全部走了 default-allow-read 通配)。迁移的价值在保护
「已升到 ≥0009 且用过 fs 类全局允许」的库;行为由单测回放实证。

## 验证(矩阵,§4.7/§5.6)

### 后端(go build/vet/test 全绿;`go test ./...` 17 包 ok)

| 场景 | 测试 | 结果 |
|---|---|---|
| read basename 跨项目同名命中 | `TestExactMatchRuleReproducesRequest/read_basename_跨项目同名命中`(/projA 固化 → /projB、/anywhere/deep 同名 allow;异名 ask) | PASS |
| write 精确跨项目不命中 | `…/write_精确路径跨项目不命中`(/projB 同名 ask;同路径 allow) | PASS |
| exec 同命令命中/变体再弹 | `…/exec_同命令放行_不同命令不命中` + `-s` 变体(git status → git status -s ask) | PASS |
| ExactMatchRule 形状分叉 | `TestExactMatchRuleShape` 8 例(read→basename、read 纯名幂等、read 多 location、write 绝对、exec ×3、无命令无路径) | PASS |
| handler 端到端形状 | `TestRequestPermissionGlobalFSShapePath` 表驱动(edit→绝对路径;read→basename) | PASS |
| 迁移 7 形状 + 幂等 | `TestMigration0020ReadBasenameRewrite`(read 绝对×2→basename、disabled 也改写、write/exec/ask/glob 不动;二次执行断言) | PASS |

### 前端(bun test --isolate 377 pass / 0 fail;npm run build、build:dev 均绿)

| 场景 | 测试/方法 | 结果 |
|---|---|---|
| 弹窗 exec/write/read/兜底 四分支文案+预览 | `ChatView.permission-hint.mount.test.tsx` ×4(真实 React 树,key 断言 + 预览值断言) | PASS |
| locale 双语 key 同步 | `locales.test.ts` | PASS |
| tsc 类型 | `npm run build`(tsc && vite build) | PASS |
| build:dev 验收命令 | `npm run build:dev` | PASS |

### 浏览器实证(远程浏览器端通道;server 模式 + **临时数据目录**)

`go build -tags server` + `XDG_DATA_HOME=/tmp/md-verify-143`(隔离目录,**未触真实库**)+
Chromium 直连 `:9343`,真实 React × 真实 SQLite binding:

| 场景 | 操作 | 结果 |
|---|---|---|
| 命令原文徽章 | 规则行 command 输入 `^git status$` | 徽章 "Exact command" + tooltip |
| 文件名徽章 | path 输入 `notes.md` | "File name" + tooltip |
| 精确路径徽章 | path 输入 `/projA/notes.md`、`/etc` | "Exact path" + tooltip |
| glob 不标 | path 输入 `docs/*.md` | 无徽章 |
| 通配不标 | command/path 全空 | 无徽章 |
| zh 本地化 | 设置语言切中文 | 徽章 "文件名"、导航全中文 |
| 截图存证 | Permissions pane | 见上(webp) |

### 三端覆盖说明(§4.7)

- **远程浏览器**:上表即本端(Chromium + `/wails/runtime` binding + server 模式)。
- **桌面 GUI**:本次改动是纯展示性增量(权限卡一行 hint、设置行一枚徽章),无布局/
  交互结构变化;mount 测试走真实 React 树 + 真实 CSS 类,webview 引擎差异风险低。
  **本环境无法起真 wails3 GUI**,桌面 WebKit 冒烟留待用户下次 `wails3 dev` 顺手确认。
- **PWA(≤768px)**:两处新增均为 flex-wrap 行内元素,不触抽屉/对话框/断点结构;
  无 hover 依赖(徽章 tooltip 在 coarse pointer 下由 §4.5 既有机制隐藏,不产生新问题)。
  未做真机/视口仿真回归,标注待下次 M 系列验证顺带冒烟。
- 后端/迁移/binding 验证统一做了一次(上两表),未按端重复(§5.6)。

## 下一步 / OPEN

- 桌面 WebKit 冒烟 + PWA ≤768px 冒烟(见三端说明;非阻塞,纯展示改动)。
- 若未来 ExactMatchRule 对多 location 请求想固化完整集合,需协议/存储配合(单条 glob
  表达不了,届时再议)。
