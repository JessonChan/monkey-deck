# 2026-08-26 Review #24293(#128 前端):DirBrowserModal + addProject 分流——PASS(附 2 处收尾修复)

## 审查对象
- `dd802fd` feat(frontend): DirBrowserModal + addProject isRemoteClient 分流(#128)。
- 范围仅前端(`frontend/src/`);后端 BrowseRoots/BrowseDir bindings 已由
  `2026-08-26-review-128-browse-bindings.md` 单独审过(PASS)。

## 结论:**PASS**(2 处收尾修复后合入,见下)

## 逐项核验(任务指定重点)

### 1. 分流零变化桌面 ✅
- `addProject` 的 `isRemoteClient()` 守卫是**前置早退**(`frontend/src/App.tsx`):桌面
  webview 下 `custom.js` 404 → `window.__mdRemote` undefined(`lib/remote.ts` 严格
  `=== true`)→ 原生 `PickDirectory` 代码路径逐行未动。
- `dirBrowserOpen` 只能经远程分支置 true → DirBrowserModal 桌面永不挂载。
- 新 CSS 全部是 `.dir-browser-*`(仅作用于该组件);≤768px 新规则(2906–2910 行)确认
  落在 2775 行起的 `@media (max-width: 768px)` 块内——>768px 无新生效规则。构造性零变化,
  无需像素 diff(与 worklog 论证一致)。

### 2. 异步竞态 ✅
- seq 守卫正确:`openDir`/`showRoots` 的 try/catch/**finally** 三处都判
  `seq !== seqRef.current`——过期响应连「清 loading」都不会错杀新请求的 loading 态。
- 边界核验:roots 加载中 `loading=true` → Enter 被 `!loading` 挡住,不会用陈旧 `cur`
  确认;错误态确认禁用(`!!error`);confirm 后 modal 立即卸载,无重复提交路径。
- **发现并修复一处键盘导航竞态**(见修复 #1)。

### 3. i18n ✅
- `dirBrowser.*` 8 键 zh/en 逐键对齐;`common.cancel`/`common.loading` 两端存在;
  `locales.test.ts` 通过。

### 4. 移动端触控 ✅
- ≤768px:up 按钮 40×40、行 min-height 40px(padding 10px 12px)、列表
  `max-height: min(300px, 45dvh)`、卡片 `calc(100vw - 20px)`;modal-overlay 在断点内
  z-index 65 > drawer 60(M2 模型,既有规则)。`data-testid` 全覆盖(§4.2),Esc 可关。

### 5. 类型补丁(反模式排查)✅
- 本机 `make bindings` 重生成后核对:`BrowseEntry{name,path}` /
  `BrowseDirResult{path,parent,dirs}` 与 Go struct 逐字段对齐,且**每个字段在组件里都有
  真实消费点**(name→行标签+图标选择;path→行 key/tooltip/下钻;cur.path→确认+路径栏;
  cur.parent→goUp+回退 roots;dirs→行渲染)。无「字段加了没人读」的死字段;`res ?? null`
  正确处理 Go nil 指针返回。

### 6. 测试断言质量 ✅(本次补强)
- 既有用例锚定值(BrowseDir 调用参数、onConfirm("/home/me")、disabled 状态),非
  「字段存在」式断言。本次把错误态断言从「error 节点存在」升级为**锚定渲染值**
  (`dirBrowser.readFailed:boom`),并新增聚焦控件 Enter 语义用例。

## 发现的问题与修复(本次 review 提交)

### 修复 #1(Medium,键盘导航):Enter 全局确认压过聚焦控件
- **问题**:`window` 级 keydown 里 Enter→onConfirm 是**本代码库新模式**(既有弹窗
  window 级只处理 Esc,Enter 只在具体 input 的 onKeyDown 上)。后果:
  - 焦点在 **Cancel** 上按 Enter → 全局 confirm 先行,项目被添加(用户意图是取消);
  - 焦点在**子目录行**上按 Enter → 确认的是当前展示目录(父目录)而非下钻该行
    (违背原生 button 激活语义);
  - 焦点在 **Confirm** 上按 Enter → 靠卸载时序侥幸避免双发 `AddProject`。
- **修法**:`DirBrowserModal.tsx` onKey 增加 target 守卫——事件目标是
  `button/input/textarea/select/a/[contenteditable]` 时跳过全局确认,让原生激活表达
  用户意图;无聚焦控件(body/window)时保留「Enter 确认当前目录」的便捷路径(与
  worklog 记载的交互承诺一致)。
- **测试**:新增用例锁三个分支(聚焦 cancel 不确认 / 聚焦行不确认 / window 级
  Enter 仍确认),6/6 过。

### 修复 #2(Minor,§4.4 错误文案):`String(e)` → `extractErrMsg(e)`
- **问题**:两个 catch 用 `String(e)` 渲染 binding 错误。Wails3 会把 Go error 序列化进
  Error message(可能是 JSON 串),`lib/errorMsg.ts` 的 `extractErrMsg` 正是为此存在,
  且 App 层 `confirmAddProjectDir` 对同一条 AddProject 路径已经用它——同一链路两种
  提取方式。
- **修法**:两处 catch 换 `extractErrMsg`;mount 测试的 `t` mock 补 `{{error}}`
  插值支持,错误态断言锚定渲染出的消息值。

## 非阻塞观察(记录,不要求改)
- overlay 无点击背景关闭:与 NewSessionModal/AddHarnessModal 一致(库内本就两派),
  非本次引入的差异。
- 无 `role="dialog"`/`aria-modal`/焦点陷阱:**全部**既有弹窗共有的缺口,非本 PR 回归;
  建议作为 codebase 级后续项单独开任务。
- 禁用态 confirm 按钮的 tooltip 在部分引擎可能不显示(disabled 元素不派发 hover),
  影响可忽略(按钮文案已自明)。

## 验证
- `make bindings` 重生成 + `bun run build`(tsc + vite)过。
- `bun test src/components/DirBrowserModal.mount.test.tsx --isolate`:**6/6 过**
  (原 5 + 新 1);`bun test src/i18n --isolate`:2/2 过(zh/en 守恒)。
- 全量 `bun test --isolate`:268 pass / 5 fail——5 个失败为 NewSessionModal 本机既有
  (#128 worklog 已记录基线 262/5,与本改动无关);净增 1 通过用例、零回归。
- 桌面零变化为构造性论证(§1),未跑像素 diff;修复只触及 DirBrowserModal 内部
  (桌面永不挂载)与测试文件,分流路径未动,论证继续成立。

## 下步
- 沿用 #128 的 OPEN:真机(手机浏览器/安装态 PWA)冒烟「+ → 目录浏览器 → 选目录」;
  NewSessionModal 5 个本机既有失败单独排查。
