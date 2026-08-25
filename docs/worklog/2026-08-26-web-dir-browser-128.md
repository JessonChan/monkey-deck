# 2026-08-26 #128 web 目录浏览器(BrowseRoots/BrowseDir + DirBrowserModal + addProject 远程分流)

## 起因
远程浏览器 / PWA 客户端点侧栏「添加项目」毫无反馈:`ChatService.PickDirectory` 在桌面宿主弹
原生目录选择对话框,远程连接上该对话框不可见(与 PickFiles 回形针同类问题,§1.8 / M2 已知)。
#128 要求给远程端一个 web 目录浏览器替代原生选择器。

## 设计
- **纯 binding,不自建 API(§1.8)**:新增两个 ChatService 只读方法,走 Wails3 既有 binding 面
  (webview / `/wails/runtime` / WS 三端同一通道),不暴露文件内容、不可写。
  - `BrowseRoots() []BrowseEntry`:起始位置 = 家目录(`~`,项目最常在)→ `/Volumes` 子项
    (darwin)→ `/`,按路径去重。
  - `BrowseDir(dir) *BrowseDirResult`:`dir` 必须绝对路径,返回清洗后的当前路径 + 父目录
    (文件系统根时为空串,前端据此回落 roots 视图)+ 直接子目录(仅目录、大小写不敏感排序;
    含点前缀隐藏目录——原生选择器也显示,`~/.config` 类项目根合法,§5.3 不丢信息;目录符号链接
    可下钻、断链跳过,与原生选择器一致)。
- **前端 `DirBrowserModal`**:导航模型 = 「只下钻 + 上级返回,confirm 永远作用于当前展示目录」
  (移动端 OS 文件夹选择器范式,无独立选中态可失同步)。roots 视图 confirm 禁用(roots 是快捷
  方式不是可选项目目录)。异步加载带 seq 守卫(快速连点只有最新响应落地)。Esc 关闭(§4.2)、
  Enter 确认、行级 tooltip 显示完整路径(§4.5)、data-testid 全覆盖(§4.2)。
- **App.addProject 分流**:`isRemoteClient()` → 打开 DirBrowserModal;桌面 → 原生 PickDirectory
  不变。confirm 走同一个 `AddProject("", path, "")` 路径。

## 改了哪些文件
- `internal/chat/browse.go`(新):BrowseEntry / BrowseDirResult 类型 + 两个 binding。
- `internal/chat/browse_test.go`(新):5 个用例(roots 含家目录与根且无重复;子目录仅目录 +
  排序 + 隐藏目录;parent 链走到根为空;相对/空/缺失/普通文件报错;目录符号链接跟、断链跳)。
- `frontend/src/components/DirBrowserModal.tsx`(新)+ `DirBrowserModal.mount.test.tsx`(新,
  5 用例:roots 禁选 / 下钻后 confirm 当前目录 / up 到根回落 roots / Esc+Enter / 错误态)。
- `frontend/src/index.css`:`.dir-browser-*` 样式 + ≤768px 块内(≥40px 触控目标、卡宽、列表
  高度上限)——全部落在断点内,>768px 无新规则作用于既有 DOM。
- `frontend/src/i18n/locales/{zh,en}.json`:`dirBrowser.*` 8 键,zh/en 对齐(locales.test.ts 守恒)。
- `frontend/src/App.tsx`:`dirBrowserOpen` state + addProject 分流 + `confirmAddProjectDir` + 渲染。
- bindings 重新生成(`wails3 generate bindings`,不入库)。

## 验证
- `go build ./...`、`go vet ./internal/chat/`、`go test ./...` 全绿。
- `bun run build`(tsc + vite)过;`bun test --isolate`:267 pass / 5 fail——**5 个
  NewSessionModal 失败为本地既有**(git stash -u 后基线同为 262 pass / 5 fail,与本改动无关,
  疑似本机 bun/环境差异;本改动净增 5 个通过用例)。
- **浏览器 E2E(server 模式 §5.5 + puppeteer,16/16 全绿)**:server 二进制 + 隔离 XDG 临时目录,
  curl 直调 binding 验证 wire(BrowseRoots 返回 ~/卷//;BrowseDir("/tmp") 返回排序子目录 + parent),
  浏览器开页验证 UI:roots 视图 confirm 禁用 → 下钻 `~`(124 个子目录行)→ up 回 /Users →
  confirm 后侧栏出现项目行;Esc 关闭。390×844 触屏视口:抽屉 → add-project → 弹窗层级正确
  (modal z-index 65 > drawer 60,M2 模型)、up 按钮 40×40、行高 40px、卡片 370px ≤ 390px、
  下钻与 confirm 正常。
- **三端矩阵(§4.7/§5.6)**:
  - 桌面 GUI:构造性不变——`isRemoteClient()` 在 webview 恒 false,走原生 PickDirectory 旧代码
    路径;DirBrowserModal 在桌面永不挂载,新 CSS 类只作用于该组件。未做像素 diff(无既有 DOM
    改动;>768px 无新增生效规则)。
  - 远程浏览器:server 模式下 wails 自举脚本不含 `__mdRemote`(内嵌远程的 custom.js 才设置),
    E2E 用 `evaluateOnNewDocument` 注入该 flag 后跑通全流程——flag 机制本身是 M1/M2 已验证的
    既有路径;真实产品路径(桌面二进制 + `MD_REMOTE_ENABLED=1` + 手机)未在本机实测,留待
    用户真机冒烟。
  - PWA:同上 390px 视口覆盖(coarse pointer 模拟)。

## 下步 / OPEN
- 真机(手机浏览器 / 安装态 PWA)走一遍「+ → 目录浏览器 → 选目录」冒烟。
- 若后续 M2.5 Capacitor 或其它流程需要选目录,复用 DirBrowserModal(必要时再加 initialPath
  之类的入口参数——当前无消费者,按 KISS 未加)。
- 本机 5 个 NewSessionModal.mount 既有失败待单独排查(非本任务范围)。
