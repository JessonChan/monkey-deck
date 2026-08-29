# Review #28404 面板拖拽 @mention 前端面复审(HTML5 通道 + appendMentionPath)(#28405)

日期:2026-08-29
被审:d6b4385(feat 面板拖拽→@mention,9 文件 +575/−4)+ 7af18a1(worklog)
结论:**APPROVE**——父 issue #28403 四点规格逐条反向追代码实证全过;测试断言锚定值非字段存在;panelDrop.ts 两端唯一事实来源成立;本机全量 gate 重跑与被审声称一致(435 pass / 0 fail)。仅 2 条 P3 备注,均不阻塞。

## 复审方法

按「类型补丁反模式」反向追踪:从规格四点出发逐条对代码消费端(不经 commit message);每个新增字段/prop/测试id/i18n key 从定义点追到真实读取/渲染点;测试逐条核对断言值(非存在性);本机重跑 tsc(无增量缓存)+ 全量测试。

## 逐件验证(规格四点)

### ① 拖源(FilePanel)✅

- 文件行 `draggable={!coarsePointer}`(FilePanel.tsx:451),目录行无 draggable(规格 MVP 单文件);`data-testid="tree-file-row"` + `data-path` 供测试锚定。
- `dragRowStart`(:410-413)只做 `writePanelFilePayload`(MIME `application/x-md-panel-file` JSON `{sessionId, path}`,path = FileNode.path 原始根相对路径,与 pickMention token 同源)+ `effectAllowed="copy"`;不碰 dataTransfer 其余 → 默认行快照拖影保留(无 setDragImage)。
- coarse 门(:52-53)与 Composer.tsx:168 / App.tsx:48 / ResizableTable.tsx:125 同一模块级 matchMedia 范式;coarse 测试先置 `matchMedia` 后动态 import(模块常量只在 import 时求值,测试顺序正确),断言 `draggable="false"` + 目录行 `null`(锚定值)。
- PanelDrag.mount.test:dragstart 后 `dt.getData(MIME)` **逐字节**等 `JSON.stringify({sessionId:"s1",path:"README.md"})`、`effectAllowed` 等 `"copy"`——锚定值 ✅。

### ② 落点(ChatView 根,双通道分流)✅

- 根节点 `.chat-view` 挂 `onDragOver/onDragLeave/onDrop`(:694-696)= 整个聊天区可落;dragover 仅 `hasPanelFilePayload`(只读 `types`,符合 HTML5 dragover 期间 payload 受保护的协议事实)才 `preventDefault` + `dropEffect="copy"` + `mentionDropActive`(:619-624)。
- overlay 变体(:721-728)复用 `.chat-drop-overlay/.chat-drop-card` 既有样式(pointer-events:none、z-index 50,原样未动),`FileText` + `t("chat.dropMentionTitle")`,`data-testid="chat-mention-drop-overlay"`;与原生 overlay(#83 Wails 类镜像)互斥——一次拖拽 types 只能含其一,结构性成立。
- dragleave(:625-631)`relatedTarget` contains 判真离开,子元素间移动不闪隐。
- OS 文件(`types=["Files"]`)零介入:本通道 handler 早退不 preventDefault,overlay 不现、草稿不动(测试三断言);测试注释如实说明 `@wailsio/runtime` 对 Files dragover 一律全局 preventDefault,故只断「本通道三不动」——断言边界诚实、与生产一致。
- i18n:zh「释放以 @引用」/ en "Release to @mention" 两侧 key 同步 + locales.test 钉死双侧字面值 ✅。

### ③ 插入(Composer appendMentionPath)✅

- `forwardRef` + `ComposerHandle.appendMentionPath(rel, name?)` 干净 cutover:Composer 全仓仅 ChatView 一个消费方,`ref={composerRef}` 已挂(:930);`useImperativeHandle` 无 deps → 每渲染重建,`value/mentions` 闭包恒新鲜,无 stale 风险。
- 语义与 pickMention(:499)同款:草稿**末尾**追加 `@<rel> `(草稿非空白结尾才补分隔空格)、mentions 按 path 去重(:569)、`setCollapsed(false)` 解折叠、`cursorRef` 同步防 @ 面板重开——复核 detectMention:追加后草稿恒以空格结尾 → `text[wordStart] !== "@"` → null → 面板 effect 关闭,确无重开路径。
- rel 归一:root 解析 `session.worktreePath || project.path`(:641)与 App.tsx:813 原生通道、后端 cwdOf 同一套;`relativeToRoot` 复用 #83 既有函数未改动;**`..` 段显式拒绝**(:651)是对前缀检查不折叠点段的正确补防(relativeToRoot 本体不动,#83 通道零变化)。
- 消费链路全通(类型补丁反查):PANEL_FILE_MIME → 三函数两端消费(grep 实证生产代码无第二处 MIME 字面量);appendMentionPath → ChatView:652 调用;dropMentionTitle → ChatView:725 渲染;两个测试 id → 测试真实断言。测试断言锚定值:`"@README.md "` / `"@README.md @README.md "` / mentions 数组逐项等值 / 草稿不变量逐字比对 ✅。

### ④ 防护 ✅

- 跨窗口:payload.sessionId ≠ 本窗口 session → preventDefault(认领)但忽略;测试二断言草稿 `""` + mentions `[]` + `defaultPrevented===true`(「认领但忽略」语义钉死)。
- 触屏:coarse 门不启用(见①);单文件:payload 单对象、面板无多选,结构上无多拖入口。
- 坏 JSON / 非对象 / 空 sessionId/path → `readPanelFilePayload` 严格校验返 null → 忽略;`".."` 穿越逐段拒绝(测试三覆盖,`defaultPrevented` + 草稿不变)。

## Gate 重跑(本机实证)

- 本 worktree 缺生成物 `frontend/bindings/` + `frontend/node_modules`(均 gitignore);`bun install --frozen-lockfile` + `wails3 generate bindings`(297 包 / 126 方法 / 25 模型)补齐。
- `bun x tsc --incremental false` → **0 错误**;`bun test --isolate` → **435 pass / 0 fail**(7505 expects,65.2s),与被审 worklog 声称的 435/0 一致;单独复跑 PanelDrag(3)+ coarse(1)+ locales(3)= 7 pass / 0 fail。minSize/maxSize React 告警为既有噪音(多个无关测试文件同现)。
- 三端口径(§4.7):逻辑层由 mount 测试锁定;i18n 双语钉死;远程浏览器端无新守卫分支(纯客户端 composer 状态变更,不经 WS/后端),PWA 端 coarse 门关闭特性即无暴露面;桌面 GUI 实机拖拽手感(拖影观感/WebKit DnD 时序)实现侧已如实标注未验,overlay 样式零新增故视觉面无新风险——留真机实测,不阻塞本卡(规格验收以 mount 四条 + gate 为准)。

## Findings 汇总

| 级别 | 项 | 位置 | 处置 |
|---|---|---|---|
| P3 | payload.path 若为绝对路径(如 "/x")会被 join 进 root 变成对不存在路径的 mention(readPanelFilePayload 不拒前导 "/")| panelDrop.ts:42 / ChatView.tsx:649 | 不阻塞:payload 由自家面板产出,永不为绝对路径;未来若开放外部拖入来源,建议在 readPanelFilePayload 契约里拒前导 "/"(实现侧 worklog 已自留同向备注) |
| P3 | `ref={composerRef}` 缩进 8 空格与兄弟 props 10 空格不一 | ChatView.tsx:930 | 纯格式,随下次触及顺带 |

## 下一步

本卡 APPROVE 收口;P3 两条无需返工(记录在案)。桌面 GUI 真机拖拽手感按实现侧 OPEN 项留真机实测回写。不 push、不关 issue。
