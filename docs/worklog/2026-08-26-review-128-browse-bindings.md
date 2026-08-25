# 2026-08-26 Review #128 后端 BrowseRoots/BrowseDir 只读 binding(PASS + 1 处测试补强)

Task #24295 / review 对象:commit `b6e82ec`(feat(chat): BrowseRoots/BrowseDir, #128)。
范围:**仅后端**(`internal/chat/browse.go` + `browse_test.go`);前端 DirBrowserModal
归前端 review,不在本次结论内。

## 审查结论:**PASS**(附 1 处收尾修复——Clean 硬门槛补锚定测试,reviewer 落地)

## 硬门槛逐项验证(反向追踪,不顺着 PR 叙述走)

1. **Clean 绝对路径无注入**:`BrowseDir` 管线 = `TrimSpace` → 空串拒绝 →
   `filepath.IsAbs`(拒绝相对路径)→ `filepath.Clean` → `Stat` → `ReadDir`;
   返回的 `Path`/`Parent`/`Dirs[].Path` 全部是清洗后的规范绝对路径。
   用独立探针程序实证边界输入:`"/tmp/a/../.."`→`"/"`、`"/tmp//x/./"`→`"/tmp/x"`、
   `"/private/tmp/../../etc"`→`"/etc"`——`..` 段被折叠,**无「基准目录」可逃逸**
   (本 API 按设计可枚举全盘目录,见第 4 条信任前提,遍历无从谈起);
   NUL 字节(`"\x00"`)Clean 不清洗但 `os.Stat` 报 `invalid argument` → 走错误
   分支优雅返回,不 panic、不下钻。
   **但该硬门槛原本零测试锚定**——补 `TestBrowseDirCleansMessyAbsoluteInput`
   (空白填充 + 冗余分隔符 + `..` 段 + 尾斜杠 → 断言 `res.Path` 等于规范路径、
   Parent 正确、entry 路径均为 clean 绝对路径;NUL 输入必须报错)。
2. **只读**:两个 binding 全部 fs 操作只有 `os.UserHomeDir`(读 env)/
   `os.ReadDir`/`os.Stat`——无写、无 chmod、无 exec、**不暴露文件内容**
   (仅目录名 + 路径)。含点前缀隐藏目录是有据的设计决策(原生选择器对齐 +
   §5.3 不丢信息,`~/.config` 类项目根合法)。
3. **优雅降级**:`BrowseRoots` 永不报错——home 取不到就跳过、`/Volumes` 读不了
   就跳过,`/` 恒在(dedup 只会去重首次出现之前的重复,`/` 必存活),最坏也返回
   单元素列表;`BrowseDir` 每个失败路径(空/相对/缺失/非目录/不可读)都返回
   `nil, err` 由前端渲染错误态,无 panic 路径;子项级失败(断链/非目录符号链接)
   `continue` 跳过而非整列表失败。并发安全:两方法无共享可变状态,
   `roots[:0]` 原地去重是标准安全惯用法(写指针恒 ≤ 读指针)。
4. **信任前提**:远程面 = §1.8 既有 token/配对鉴权,`/wails/runtime` 无方法级
   allowlist——BrowseRoots/BrowseDir 与其它 ChatService binding 同通道可达(无
   「方法加了但远程路由不到」的类型补丁问题)。已配对客户端本就能 `AddProject`
   任意路径再跑带 shell 的 agent——**目录名枚举的权限严格低于既有远程信任面**,
   前提自洽;文件头注释已明示只读定位。

## 其它核对

- **消费链闭环(反类型补丁)**:`BrowseEntry`/`BrowseDirResult` 三字段
  (Path/Parent/Dirs)全部被 `DirBrowserModal.tsx` 消费(Parent 驱动上级导航、
  空 Parent 回落 roots 视图),bindings 生成链路经 E2E wire 实证(worklog 记录
  curl 直调往返)。无死字段。
- **测试断言锚定值**:既有 5 用例锚定的是具体值(排序序 `.hidden<Alpha<beta<zeta`、
  home 根名必须为 `~`、entry path 必须等于 `Join(base,name)`),非「字段存在」式
  断言 ✓。
- **符号链接语义**:`Stat` 跟随目录符号链接可下钻、断链跳过;`BrowseDir` 对
  「符号链接路径本身」也成立(Stat 跟随),Parent 取符号链接所在目录——与
  「当前展示路径」导航模型一致,不 resolve 目标侧父目录,行为自洽。单层
  `ReadDir` 无递归 → 服务端无符号链接环路风险。

## 发现的问题(1 修复 + 1 OPEN + 2 备注)

- **[已修复] Clean 硬门槛无测试锚定**:行为本身正确(见上),但硬门槛必须钉死
  ——未来重构(去掉 Clean / 调整校验顺序)若无测试会静默回归。补
  `TestBrowseDirCleansMessyAbsoluteInput`(含 NUL 断言)。
- **[OPEN] Windows 下 `/` 根是死入口**:`volumeRoots()` 无条件追加
  `{"/","/"}`,但 Windows 上 `filepath.IsAbs("/")` 为 false → 点击必报
  「not an absolute path」。darwin/linux 无此问题。正确修法需要按 OS 枚举驱动器
  根(Windows 盘符),但本机无法实证 Windows 行为,按 §5.3「外部事实先验证再
  动手」不做投机实现,记 OPEN 待 Windows 目标平台启动时一并处理(届时
  `BrowseRoots` 也应补 Windows roots)。
- **[备注] 排序 locale 天真**:`strings.ToLower` 比较非文化正确——目录选择器
  场景可接受,不改。
- **[备注] 错误串回显输入路径**(`not an absolute path: %s`):React 侧转义,
  picker 语境下可读性 OK,不改。

## 改了哪些文件

- `internal/chat/browse_test.go`:+1 用例 `TestBrowseDirCleansMessyAbsoluteInput`
  (锚定 Clean/绝对路径/NUL 拒绝)。

## 验证

- `go vet ./internal/chat/` 过;`go test ./internal/chat/`:全绿(含新用例,
  Browse 系列 6/6)。
- `go test ./...`:internal 全部 `ok`(根包 `github.com/jessonchan/monkey-deck`
  setup fail 系本 worktree 未构建 `frontend/dist`(embed 无匹配文件)的环境
  产物,非代码缺陷——coder 侧 worklog 已记录 `bun run build` + `go build ./...`
  通过)。
- 三端(§4.7):本次仅加 Go 单测,不触任何 binding 签名/行为,三端零影响。

## 下一步

- OPEN:Windows roots(见上)。
- 真机冒烟(原 worklog 已列,非本次范围)。
