# 2026-08-26 #46 探针重派:两次真实配额耗尽(14:59/19:43)回溯 + ACP 输出形态实证(Task #24343)

> 探针任务,不改产品代码。目的:为 #46(配额耗尽的识别与呈现)拿到第一手事实——
> ①回溯今天两次真实 5h 配额耗尽事件;②实证「配额耗尽时 ACP client 到底收到什么」。
> 探针产物(throwaway,不入库):`/var/folders/.../T/opencode/quota-probe/`
> (`mock_provider.py` / `proj/opencode.json` / `acp_quota_probe.py`)。

## 起因

- #46 需要在 monkey-deck 里把「LLM 供应商配额耗尽」从一堆错误里识别出来、用人话呈现
  (含重置时间)。§5.3 外部事实先验证:动手设计前必须先实证「配额耗尽经 harness(opencode)
  到 ACP client 的输出形态」,不能凭猜测写识别器。
- 今天恰有两次**真实**配额耗尽(也就是拖死 #24331/#24332 两次派发的元凶,见
  `2026-08-26-queue-repeat-send-111.md`):本地留有完整日志,是最好的回溯样本。
- 前一次 #46 探针派发失败(重派原因),本次为零代码探针:只取证、只落 worklog。

## A. 两次真实事件回溯(`~/.local/share/opencode/log/opencode.log`,时间已换算 +08:00)

共同背景:providerID=bigmodel-coding,modelID=glm-5.2,agent=build。

| | 事件 1(14:59) | 事件 2(19:43) |
|---|---|---|
| session | `ses_fc32b924dffeg8kJqunW2cjbkB` | `ses_fc2cf30ffffeRyLq1cQ4OOfv15` |
| 目录 | `workspaces/ff59475b/worktree`(Task #24332 重派,重试续跑提示后 2s 即撞墙) | `agents/edec7a61-…/chat`(编排侧 chat agent) |
| 错误行(UTC) | `06:59:10.060Z level=ERROR message="stream error" … error.error="AI_APICallError: 已达到 5 小时的使用上限。您的限额将在 2026-08-26 16:32:32 重置。"` | `11:43:14.452Z … "AI_APICallError: 已达到 5 小时的使用上限。您的限额将在 2026-08-26 21:32:49 重置。"` |
| 重试链 | 5 次尝试:06:58:34.663→36.930→41.333→50.390→59:10.060(间隔 2.3/4.4/9.1/19.7s,×2 指数退避),总耗时 ~35s 后放弃 | 5 次尝试:11:42:41.219→43.751→48.101→57.223→43:14.452(同款退避),~33s 放弃 |

**关键回溯结论**:
1. 错误文本自带重置时刻:`已达到 5 小时的使用上限。您的限额将在 YYYY-MM-DD HH:MM:SS 重置。`
   (带全前端要展示的信息,**不需要**再调任何接口)。
2. opencode 内部对 429 做 **5 次 ×2 指数退避重试(~33-35s),全程对 ACP client 不可见**——
   印证 §3.3「Prompt 不设超时」的既有结论:这半分钟是正常重试窗口,不是挂死。
3. opencode 自身持久化(`~/.local/share/opencode/opencode.db`):失败 turn 的 assistant
   message(`msg_03cdd048…` / `msg_03de1223…`)**存在但零 parts**——配额耗尽不产生任何
   协议内容,session 历史里只留一个空壳消息。

## B. 输出形态实证(活体 wire 探针)

方法(§5.3 最小成本复现,非猜测):本地 mock provider(127.0.0.1:8765)对
`POST /v1/chat/completions` 恒回 **429** + 真实错误文本的 JSON body;临时项目目录
`proj/opencode.json` 注册自定义 provider(quotamock/quota-glm)指向 mock;裸 Python
JSON-RPC client spawn `opencode acp`(v1.18.23,与 rak/monkey-deck 同款二进制)走完整
生命周期 initialize → session/new → session/prompt,逐行记录 wire 消息。

**实证结果(配额耗尽 turn 的 ACP 输出形态)**:

1. **重试期间 wire 完全静默**:唯一一条 `session/update` 是 session 开始的
   `available_commands_update`;5 次重试零事件、零 token 输出。
2. **最终以 `session/prompt` 的 JSON-RPC error response 收场**(不是 end_turn,不是空 turn,
   不是任何 SessionUpdate):
   ```json
   {"jsonrpc":"2.0","id":3,"error":{
     "code":-32603,
     "message":"Internal error: 已达到 5 小时的使用上限。您的限额将在 2026-08-26 16:32:32 重置。",
     "data":{"service":"session","errorName":"APIError"}}}
   ```
   prompt 阻塞 72.2s 后返回(mock 下退避更慢;真实事件 ~33-35s)。
3. **stderr 同步可见**(无 `--print-logs` 也有):bun inspect 风格的
   `Error handling request {jsonrpc…method:"session/prompt"…} {code:-32603,…errorName:"APIError"}`
   ——monkey-deck 的 stderr ring(§5.4 #1)天然能留档,但**识别应以 wire 为主**。
4. **SDK 侧落点**:acp-go-sdk v0.13.5 把它变成 `*acp.RequestError{Code:-32603,
   Message:"Internal error: 已达到…重置。", Data:{"service":"session","errorName":"APIError"}}`,
   message/data 原样保留——检测所需信号(client 侧)全在带内。

## C. monkey-deck 现状缺口(chat.go runPrompt,行号为本 worktree)

`runPrompt` 对「非取消的 Prompt 错误」一刀切(chat.go:2216-2240):
`teardownLive + emitError(ErrCodeHarnessDisconnected) + startReconnect`。
对照实证,配额耗尽时这三步**全错**:

1. **误诊为 harness 死亡**:实际 harness 进程活着、连接健康(下一步消息完全可以复用);
   teardown 杀掉健康 harness。
2. **无意义重连**:startReconnect spawn 新 harness(~90s 探测链),配额不会因此恢复,
   纯浪费;且旧 turn 的真实死因被 generic 错误顶掉。
3. **用户丢信息**:前端只见 i18n 的「harness 断连」,**「配额耗尽 + 何时重置」这条
   最关键的信息在 emitError 处被丢弃**(§4.4 反面:该转述的没转述)。

## D. 给 #46 实现的建议(仅结论,不实现)

- **识别点**:`Prompt` 返回的 `*acp.RequestError`,按 message 正则锚定
  `已达到.*使用上限.*重置`(宽一点可再并 `usage limit`/`quota` 英文变体);
  `data.errorName=="APIError"` 只能当弱信号(其它 API 错误同名),**不要**当主判据
  (§5.3 找不变量:配额文本里的「重置时刻」才是稳定锚)。
- **处置**:新 ErrCode(如 `provider_quota_exhausted`),**不 teardown、不 reconnect**,
  推 error 状态携带从 message 解析出的重置时刻(时区注意:文本是 +08:00 本地时间);
  i18n 双语文案「配额已耗尽,将于 X 重置」。
- **回归边界**:仅 `RequestError` 且文本命中才走新分支;peer-disconnected / 其它错误
  路径原样(§3.3 的崩溃重连语义不被稀释)。配一个「429 mock + RequestError 判定」的
  单测(纯函数判定器,不起真 harness,§5.1)。

## 验证

- 回溯链:opencode.log 两次事件原始行(§A 表)+ opencode.db 两个空壳 assistant message
  (零 parts)逐条核对,时间戳 UTC→+08:00 换算正确。
- wire 探针:mock 429 → 5 次重试静默 → JSON-RPC -32603 error(§B 原文截获),复跑方式:
  `python3 mock_provider.py & python3 acp_quota_probe.py proj 240`(探针目录,临时不入库)。
- mock 与真实两链交叉一致:错误文本/退避节奏(×2 指数)/最终 JSON-RPC error 形态相同,
  mock 复现可信。探针结束后 mock server 已 kill,仓库零残留(`git status` clean)。

## 下一步

- #46 按 §D 落实现(判定器 + 新 ErrCode + 不拆连接分支 + 前端 i18n/呈现 + 单测),
  另行派发;本探针的形态结论是实现的事实基础。
