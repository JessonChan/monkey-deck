# review #158 elicitation 前端面:i18n + notice 消费链(Task #28392)

## 结论

**APPROVE**。commit `2093c4d` 前端面(`frontend/src/i18n/locales/{zh,en}.json` 各 +1 key;notice 消费链为既有通用路径,零前端代码改动)。零阻塞问题,2 条 P3 观察留档。

## 审查方法

按「类型补丁」反模式反向追踪:从新增 i18n key 与后端错误码定义点出发,沿消费链逐链接实证到最终渲染;再核对 Go↔TS 类型对齐、i18n 全量 parity、tsc/测试。

## 逐项核验(全部实证)

### 1. notice 消费链通电(反模式反向追踪)

```
chat.go startLive SetElicitationUnrenderable 闭包 → s.emit(EventStatus="chat:status",
  StatusPayload{SessionID: se.ID, Status:"notice", Code:"elicitation_unrenderable"})
→ App.tsx:631 Events.On("chat:status")
→ App.tsx:671 门控(status==="notice" && sessionId===selectedSessionIdRef && 非 popout)
→ App.tsx:672 setNotice(t('chat.notice.elicitation_unrenderable'))(code 驱动 i18n,detail 兜底)
→ ChatView.tsx:818-820 notice-bar 蓝色提示条渲染
```

每链接均读源码确认,非顺推 commit message。key 为动态插值路径(`chat.notice.${code}`),静态搜索证不了通电,已逐链接肉眼 + 运行时解析双验。

### 2. Go↔TS 类型对齐

- `StatusPayload`(types.ts:126-134)`{sessionId, status(含 "notice"), code?, detail?}` ↔ Go JSON tags 一致(后端面复审已证,前端侧复核);
- `ElicitationPrompt`/`ElicitationField`(types.ts:109-124)`id/sessionId/message/fields` + `name/type/title/description/enum/default/required` ↔ `internal/acp/elicitation.go:26-41` JSON tags 逐字段一致;
- `RespondElicitation(sessionID, reqID, action, contentJSON)`(App.tsx:1457)↔ Go 方法签名(chat.go:2666)与生成 binding(`chatservice.js:846`,4 string 参数)一致。

### 3. i18n 覆盖(zh + en)

- 全量 parity 脚本实证:**693/693 key 双向零漂移**,无空值 key;
- `chat.notice.elicitation_unrenderable`:zh=「表单不可渲染,已自动婉拒。」en="Form could not be rendered; declined automatically.",双语均解析成功,句末标点各语言习惯一致;
- `chat.notice.*` 闭集两侧同为 `{harness_empty_turn, elicitation_unrenderable}`;
- ElicitationCard 消费的 `chat.elicitationTitleFallback` / `chat.elicitAccept` / `chat.elicitSkip` 双语齐;
- 两 locale 文件 JSON 解析合法。

### 4. 状态机 / 边界

- **无幽灵卡片**:fields==0 在后端已 Decline + 发 notice,不 emit `chat:elicitation` → 前端不会渲染零字段卡片(即便到达,ElicitationCard multi 分支退化为 header+按钮,可防御);
- **侧栏无卡死态**:`STATUS_MAP.notice → chat.status.idle/st-idle`(ChatView.tsx:113),notice 状态的 session 侧栏显示空闲,不会停留怪异态;
- **session 门控**:notice 仅对当前选中 session 弹、popout session 主窗不弹(App.tsx:671,与 error 门控对称);切走的 session 的 notice 为瞬态丢弃——与 error/empty-turn 既有语义一致,属设计而非缺陷;
- **`t` 闭包**:挂载 effect 依赖数组不含 `t`,但 i18next fixed-t(null, ns) 调用时解析当前语言,且与全部 `chat.error.*` code 路径同构(#46 起 ~30 处既有模式),非本次改动引入。

### 5. 无障碍 / 测试锚点

- ElicitationCard:`data-testid="elicitation-card"` + 每字段 `elicit-${name}` + `elicit-accept`/`elicit-decline`,原生控件天然可键盘操作,文本输入 Enter 提交;非模态弹窗(inline 卡片,cancel 语义 = Stop 按钮,注释已声明),§4.2 Esc 规则不适用;
- notice-bar 为纯展示 div,无 aria-live(见 P3-1)。

## P3 观察留档(不阻塞)

1. **notice-bar / error-bar 均无 `aria-live`/`role="status"`**:读屏用户听不到瞬态提示条。既有共享模式(error-bar 同),修复应两 bar 一起做,超出 #158 范围;
2. **notice 文案在 setNotice 时已固化为译文**:显示期间切语言不重译当前条(下一条 notice 起新语言)。与 error 条同构,量级极小。

## 验证记录

| 项 | 结果 |
|---|---|
| i18n zh/en 全量 key parity(693/693)+ #158 key 双语解析 | ✅ |
| `bunx tsc --noEmit`(补生成 gitignored bindings 后) | ✅ exit 0 |
| `bun test --isolate` 全量 | ✅ 420 pass / 0 fail(56 文件,7414 expect) |
| Go↔TS 结构对齐(StatusPayload/Elicitation*/RespondElicitation binding) | ✅ 逐字段 |

环境备注:worktree 缺 `frontend/bindings/`(`.gitignore:40` 排除的中间产物),`wails3 generate bindings` 重新生成后 tsc 全绿;另 worktree 下 `wails3 gen bindings` 子命令不存在,正确命令为 `wails3 generate bindings`。

## 下一步

无。P3 两条供后续可访问性专项统一处理。
