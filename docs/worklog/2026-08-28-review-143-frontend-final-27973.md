# Review #27973:#143 前端面终审(弹窗按动作明示 + 规则形状标源)

日期:2026-08-28
状态:**APPROVE**(无阻塞项,3×P3 非阻塞记录在案)
审查对象:`3d058fb`(ChatView.tsx / PermissionSettings.tsx / 新挂载测试 ×4 / locales ×2 / index.css),基线 `bba6867`;后端面已由 #27972 终审 APPROVE(cb842ab),本次不复审后端。

## 审查方法

反向追踪消费链(防「类型补丁」空壳:从字段/key/class 定义点逐个确认真实读取与渲染,不顺着 commit message 叙事走)+ 全量前端测试与 tsc 构建复跑 + CSS 变量/布局/tooltip 宿主逐一核对。

## 逐项验证(证据)

1. **wire 对齐(Go ↔ TS)**:`internal/acp/handler.go:174-185` `PermissionPrompt` 的 `actionType/command/locations`(均 omitempty)与 `frontend/src/types.ts:95-104` 的 optional 字段逐一对应;`chat:permission` 事件(App.tsx:554)整包透传,前端无中间映射层,字段不丢。
2. **消费链通电(非空壳)**:
   - `prompt.command` → `globalHint` exec 分支(ChatView.tsx:1634)→ `<code data-testid="perm-global-preview">` 渲染;
   - `locations[0]` → read 分支经 `baseName()`(basename 预览)、write 分支原值(绝对路径预览),取不到 → 通用文案且 preview 恒空;
   - `shape.key/tip/testid`(PermissionSettings.tsx:173-177)→ 徽章 span + `data-tooltip-id="md-tip"`,tooltip 宿主在 App 根挂载(App.tsx:2516,coarse pointer 隐藏为 §4.5 既有设计);
   - 新 CSS 类 `.permission-global-hint` / `.perm-shape` 均被组件使用,引用的变量(`--text-3/--mono/--amber/--accent-2/--elev/--sep`)在 index.css :root 全部存在。
3. **分支顺序与后端一致**:命令优先(command → read → write → generic),与 `ExactMatchRule` 的 exec 优先分支顺序对齐,不会出现「弹窗说按文件名记、实际记了命令」的错位。
4. **布局/溢出**:`.perm-rule-row` 为 flex(index.css:2541),徽章 `align-self: center` 生效;hint 预览 `code` 带 `word-break: break-all` + 行 `flex-wrap`,长命令预览不撑破权限卡。
5. **i18n 双语同步**:`permGlobalHint*` ×4 + `settings.perm.shape*` ×6 共 10 key 在 en/zh 逐一对齐(locales.test 绿;zh 文案与 en 语义一致,read 文案明示「任意目录同名放行」)。
6. **测试断言锚定值**:4 例挂载测试断言具体预览值(`toBe("git status")` / `toBe("notes.md")` / `toBe("/projA/notes.md")`),generic 分支断言 preview **不存在**(`toBeNull`)——非「字段存在」式断言。
7. **测试/构建复跑**(本 worktree 补装依赖 + 生成 bindings 后):`bun test --isolate` 全量 **377 pass / 0 fail**(与 3e28a42 记录一致);`npm run build`(tsc + vite)绿(仅既有 chunk-size 警告)。
8. **AGENTS.md 合规**:新元素带 data-testid(§4.2);tooltip 走 react-tooltip 非原生 title(§4.5);worklog 三端说明齐备(§4.7,远程浏览器端实证 + 另两端纯展示增量的显式理由)。

## P3 非阻塞(记录在案,不要求本次修)

1. **`other` 动作带路径时文案欠精确**:`actionType:"other"` + locations 走 generic 兜底,而后端 `ExactMatchRule` 对 write/edit/other 实际固化**绝对路径**——用户被告知的比实际发生的更模糊(保守方向,无危害);如后续细化可给 other 加 `permGlobalHintWrite` 同款分支。
2. **形状徽章为 best-effort 启发式**:用户手写的形如 `^…$` 的 command glob(如 `^git (status|diff)$`)会被标成「命令原文」;无 `/` 的 Windows 反斜杠路径同理可能标成「文件名」。纯展示不参与匹配,worklog 已声明「只标注全局允许生成的三种形态」;彻底解法是规则加来源字段(与 #27972 P3-1 的 author=global-allow 提议同源)。
3. **既有环境坑(非本提交引入,2026-08-26 review #24320 已记录)**:bindings 生成在 `frontend/bindings/` 而源码 import `frontend/src/bindings/`——新测试正确地 `mock.module` 掉 bindings,不受影响;但全量套件中 3 个未触碰文件(Composer/RemoteSettingsPane 系)需先 `ln -sfn ../bindings frontend/src/bindings` 才能跑,本 review 已按此复现 377 全绿。该路径分歧建议后续统一(生成目录或 import 二选一)。

## 结论

消费链全链路通电:每个新字段/key/CSS 类都有真实读取与渲染端,测试锚定值断言在位,双语同步,布局无溢出风险,构建与全量测试复跑绿。APPROVE。P1-2 无;P3 三条留档(其中 #3 为既有环境债)。
