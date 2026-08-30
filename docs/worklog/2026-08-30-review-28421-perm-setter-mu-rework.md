# 2026-08-30 review #28422 复审 #28421 返工 SetPermissionRecovery 补 mu + 注释如实——APPROVE

## 起因

后端审卡(Task #28422):复审 #28421 返工 commit 09f99c7(基线 b147da0,返工 worklog a06b287),
对 #28420 审单(docs/worklog/2026-08-30-review-28418-perm-deny-backend.md)P2/P3 清单逐条闭环
验收,勿扩范围。审法:diff 逐行核、从 setter 沿写读两侧追到真实消费端、内存模型边独立推导
(不顺返工叙事)、gate 本机全新重跑。

## 结论:**APPROVE**(P2、P3 全部闭环;夹带检查干净;行为零变化实证)

## P2 逐条验收(mu 硬化 + happens-before 边)

**① 两行赋值入锁,与 sibling 五 setter 同形** ✅
- `SetPermissionRecovery`(handler.go:334-342):`h.mu.Lock()`(:338)包住
  `h.permRetries = retries`(:339)与 `h.permTimeoutPolicy = timeoutPolicy`(:340),
  `h.mu.Unlock()`(:341)。形状与 mu 系 sibling 逐一比对相同
  (`SetGlobalRule`:620-624、`SetCommandsCache`:654-658、`SetElicitationResolved`/
  `SetElicitationUnrenderable`(elicitation.go:165-178),均 Lock/赋值/Unlock;
  `SetProjectAllowExternal`/`SetPermissionRules` 走 atomic,不适用)。

**② 读侧 happens-before 边成立,formal data race 消除** ✅(独立推导,非复述)
- 读侧两处(handler.go:443 `retries := h.permRetries`、:496
  `timeoutPolicyAllow(h.permTimeoutPolicy)`;返工前审单引用的 :440/:493 因 mu 增 2 行
  顺移)是裸读,但**同一 RequestPermission 栈内 :428 已 `h.mu.Lock()`**(:428-437 临界区,
  :443/:496 均在其后的同 goroutine 程序序上)。
- Go 内存模型 mutex 规则(go.dev/ref/mem,2009 原版与 2022 修订版同文):「For any
  sync.Mutex l and n < m, call n of l.Unlock() is synchronized before call m of l.Lock()
  returning true」——setter 的 Unlock(:341)在全局锁序上先于 reader 的 :428 Lock
  (因果链:请求权限回调只能由 prompt 触发,prompt 在 startLive 装配完成后发送),
  由此 setter 写(:339-340,程序序先于 :341)happens-before :443/:496 读。
  **formal data race 消除,不依赖「时序上无并发窗口」的弱论证。**
- 附带收益:两字段成对写入获得互斥,不再可能出现「retries 取自一次调用、policy 取自
  另一次调用」的撕裂对。
- `go test -race ./internal/acp/` ✅(本机 4.32s)。

**③ chat.go:1685 注释随之自动为真** ✅
- 该行未改(diff 无 chat.go),其文字「Setter 装配形式,与上方 SetGlobalRule 同理
  (ACP reader goroutine 已启动,mu 对齐写)」——写侧现为 mu 对齐写,陈述为真。

**④ 行为零变化** ✅
- `retries<0 归 0` 钳制保持(:335-337);policy verbatim 存储保持(:340,无归一化);
  读侧预算切分(:443-454)与降级分支(:496-513)零改动。
- 定向测试锚定值复核:`TestPermissionTimeoutDefaultsToDeny`(不调 setter,出厂态
  deny 降级 + 2 次分发=DefaultPermRetries+1)、`TestPermissionWiredDefaultsDeny`
  (deny 降级 + 字面 2 次)均 PASS,日志与返工前逐字同形。

## P3 逐条验收(setter 文档如实)

✅ handler.go:331-332 改为「timeoutPolicy 为 "allow"/"deny";空串/未知视作 allow
(与零值语义一致),chat 装配层负责归一(normalizePermTimeoutPolicy)」——与实现三处
逐一吻合:verbatim 存储(:340);`timeoutPolicyAllow` 空/未知落 allow(:301-308,与
零值语义一致);生产唯一 caller chat.go:1686 经 `permissionTimeoutPolicySetting` →
`normalizePermTimeoutPolicy`(chat.go:3703-3710)归一。措辞与 #28420 审单②修法建议
逐字一致,未夹带行为改动。

## 夹带检查

`git diff 09f99c7^..09f99c7`:仅 `internal/acp/handler.go`,+4/-1(2 行注释替换 +
2 行 Lock/Unlock)。无其它文件、无行为面改动;`timeoutPolicyAllow`/
`normalizePermTimeoutPolicy` 及全部测试未触碰(diff 零命中)。返工 worklog(a06b287)
与代码(09f99c7)分离提交,符合 §6.2。

## 独立重跑 gate(本机全新跑,非复述)

- 前置(与 #28420/#28421 记录相同,环境级非代码问题):新 worktree 缺 gitignored
  `frontend/dist`/`frontend/bindings` → `bun install` + `wails3 generate bindings
  -clean=true -ts -i`(297 packages/128 methods,与前两卡数字一致)+ `bun run build` ✅。
- `go build ./...` ✅;`go vet ./...` ✅(ld "newer macOS version" 为环境级 SDK 噪音)。
- `go test ./...` ✅ **15/15 包全 ok**(acp 3.14s、chat 21.49s、worktree 8.67s 等,0 fail)。
- **race 佐证(P2)**:`go test -race ./internal/acp/` ✅ ok 4.32s。
- 定向 verbose:`TestPermissionTimeoutDefaultsToDeny` / `TestPermissionWiredDefaultsDeny`
  2/2 PASS(0.40s each)。

## 三端说明(§4.7)

纯后端单文件同步+注释改动:后端能力统一实证一次(go test 全绿 + race ok);未触碰前端,
binding 签名零变化(重新生成仅为构建前置产物)。桌面 GUI/远程浏览器/PWA 三端通道不受
影响,无需前端回归。

## 观察(不阻塞,记录在案)

- mu 系 sibling 的**读侧**均在 mu 内快照(`emitGlobalRule`:602-604、
  `emitCommandsCache`:637-639、notifyElicitation* 同理);本字段的 :443/:496 裸读依赖
  RequestPermission 自身 :428 的 Lock + 模型 n<m 规则成立,比 sibling 的直接配对式
  略 subtle。当前无生产热注入 caller(grep 全仓仅 startLive:1686;设置变更明确
  「不热更」,chat.go:3728),边无条件成立;若未来出现「活跃 session 热重注入」路径,
  需复核该边仍闭合(届时读侧 mu 快照是更直白的形态)。仅记观察,不扩范围。

## 验证

- P2/P3 逐条闭环(见上)+ 夹带检查干净 + gate 独立重跑全绿(15/15 包 + race ok +
  2 定向 PASS)。
- 本 worklog 单独 commit(docs 与代码分离,§6.2);不 push,不关 issue,停 completed-ready。

## 下一步 / OPEN

- 无。#28418 复审链(#28420 → #28421 返工 → 本卡)后端面全部关闭。
