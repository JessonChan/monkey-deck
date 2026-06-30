# 2026-07-01 侧栏会话状态错位：「生成中」与「就绪」不一致

## 现象
用户发现标题为「wails3 task package 出错,修复下」的 session,左侧侧栏常驻「生成中」(旋转 spinner),但对话面板实际显示「就绪」(空闲可输入)——两侧状态不一致。用户要求调查根因。

## 根因(纯前端状态判定,非后端 bug)

`frontend/src/components/Sidebar.tsx:132` 把 **`"started"`** 归入 `active`(进行中):

```js
const active = st === "prompting" || st === "started";  // ← bug
```

但 **`"started"` 语义是「harness 已 spawn、等首条消息」**,即空闲/就绪。`ChatView.tsx:51` 已将其正确映射为 `{ label: "就绪", cls: "st-idle" }`。

触发路径:
- 新建 session 后 warm(`ensureLive`→`startLive`→emit `"started"`),但用户尚未发消息;
- reopen session 后 respawn。

后端不会再发 `"idle"` 纠正——`"started"` 已是最新状态。

**两层叠加**:ChatView 正确映射「就绪」,Sidebar 仍归「生成中」→ 用户看到的就是两端不一致。

## 改法
`frontend/src/components/Sidebar.tsx`:仅 `prompting` 为 active:

```js
const active = st === "prompting";
```

`cls` 生成逻辑不变(`error`→error / `active`(即 prompting)→`act ?? "running"` / 其他→gray),`active` 分支只对 `prompting` 走,`started` 归回 inactive(灰点、无 spinner)。

## 改了哪些文件
| 文件 | 改动 |
|---|---|
| `frontend/src/components/Sidebar.tsx` | `active` 判定去掉 `\|\| st === "started"`(1 行,1 删 1 加,纯前端) |

## 验证
- `npx tsc --noEmit` 通过(frontend 无类型错误)
- `go build ./internal/... .` 通过(后端零改动)
- 逻辑审查:`started` 只触发一次过渡(首条消息时 `startLive`),`prompting`/`idle`/`error` 流转不变,不会引起其它 session 闪烁/错乱

## 权衡
- 无后端修改 → 不改 Go 导出签名、无需 `wails3 gen bindings`、无需重启即生效(热重载即刷新)
- 纯前端修复,tsc 编译与逻辑审查足以覆盖,未启真 harness 复现(已调过的已知坑,不需要重复验证)

## 后续
- 启动 `wails3 dev` 后快速回归:新建一个 session,确认侧栏状态为「空闲/就绪」;发一条消息确认「生成中」→「空闲」循环正常。

## 提交说明
```
fix(sidebar): 'started' is idle/ready, not generating — drop it from active flag
```
