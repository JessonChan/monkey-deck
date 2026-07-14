# 2026-07-14 对话结束提示音(设置开关)

## 起因

Task #15131:桌面客户端常驻后台,agent 一轮回复可能跑很久。用户切走干别的活,回合结束
时需要一个**听觉提醒**把他叫回来。需求是「对话结束(agent 回复完成)时播放提示音」,
带一个可开关的设置项,默认开启。

## 设计

**前端为主、零音频资源、零新增依赖**(AGENTS.md §5.3 成熟库优先 / KISS):

1. **开关持久化**:`localStorage`(键 `md:notify-sound`,`"1"/"0"`,默认开)。与语言开关
   同级,复用既有「轻量前端设置走 localStorage」模式,不引入后端 / SQLite 配置表(那是
   阶段 2 的事,此处提前实现违反 §3.1)。
2. **提示音合成**:用原生 **Web Audio API** 合成两声升调 sine chime(880Hz → 1320Hz,
   带增益淡入淡出包络避免爆音)。零音频文件、零依赖,跨平台一致(Wails3 WebView 均支持
   Web Audio,§4.6 轻量约束)。AudioContext 单例懒创建,在 `playNotifySound` 内
   `resume()` 解锁 autoplay(用户发消息是前置手势,满足策略)。全程 try/catch 静默失败
   ——提示音是锦上添花,绝不打断主流程。
3. **触发判定(关键)**:在 `chat:status` 事件 handler 里,当 `status === "idle"` **且**
   `detail` 以 `stopReason=` 开头时播放。
   - **为什么用 `detail` 而不是「prompting → idle 状态转移」**:后端发 idle 有三种来源
     (chat.go):① `stopReason=...` = agent 自然回合结束;② `cancelled` = 用户主动停;
     ③ 空 detail = `StopSession` 命中无在跑 turn 的兜底。只有 ① 是「agent 回复完成」。
     按 §5.3「尊重数据源,转换层不丢弃标识」——`detail` 是协议稳定信号,直接用它区分,
     比加 `prevStatusBySessionRef` 启发式判定状态转移更稳(后者对事件时序做假设)。
   - 仅开关开启时才调 `playNotifySound()`。
   - 不区分前后台 session:后台 session 回合结束也播音(这正是「提醒」的价值);前端
     已有 unread 小圆点做视觉补充。

## 改了哪些文件

- `frontend/src/lib/notifySound.ts`(**新增**):开关读写 + Web Audio 合成播音。
- `frontend/src/components/Sidebar.tsx`:侧栏头部新增 bell/bell-off 图标按钮
  (`data-testid="toggle-notify-sound"`),点击切换 + 持久化,tooltip 反映当前态。
  复用既有 `icon-btn` / `react-tooltip` 体系。
- `frontend/src/App.tsx`:`chat:status` handler 的 idle 分支加入触发判定 + 播音。
- `frontend/src/i18n/locales/{zh,en}.json`:新增 `settings.notifySound.{onTip,offTip}`。

## 验证

- `cd frontend && bun run build`:tsc + vite 通过(先生成 `wails3 generate bindings`,
  bindings 不入库)。
- `go build ./...` / `go vet ./...`:clean(仅无关的 macOS SDK 链接器 warning)。
- `go test ./...`:全部包通过。
- `cd frontend && bun run test`:27 pass / 0 fail。

## 下一步(非本次范围)

- 音量 / 音效选择(任务标注「非必须」,本次先落地开关 + 默认音)。
- 若后续要把应用配置统一收口到 SQLite(config 阶段),再把此开关迁过去;当前 localStorage
  足够,不提前实现。
