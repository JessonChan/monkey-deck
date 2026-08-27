# 2026-08-27 · Review:侧栏定时发送闹钟标识(#138 / Task #24915)

## 对象

- `02b4ae8` feat(frontend): 侧栏定时发送闹钟标识——scheduledBySession 快照派生 + draft-indicator 同款 AlarmClock 芯片
- `361e1db` docs(worklog): 配套落地记录

## 结论:**PASS,建议关 #138**

逐链路反向追踪(「类型补丁」反模式核对:从字段定义点出发确认每个消费端真的被读取/渲染),全链通电:

| 环节 | 位置 | 核对结果 |
|---|---|---|
| 数据源 | App.tsx:692-695 `chat:queue` → `setQueueBySession` 整体替换 | ✅ 后端每次 enqueue/revoke/edit/schedule/drain 及 OpenSession 均广播快照,幂等镜像 |
| 派生 | App.tsx:376-390 useMemo(earliest future scheduledAt) | ✅ `now = Date.now()` 在 memo 回调体内,依赖 `[queueBySession]` 正确;循环项(#111)re-arm 后新快照自然给出下次时刻 |
| prop 接线 | App.tsx:2179 | ✅ 且确认第一轮踩坑涉及的 `hasTermBySession={hasTermBySession}`(2178 行)完整在位 |
| 渲染消费 | Sidebar.tsx:777-785 IIFE | ✅ 三处真实消费:`at > Date.now()` 门、tooltip 的 `formatDateTime(at)` 插值、testid——不是空壳字段 |
| i18n | en/zh 各一条 `sidebar.scheduledTip`(均含 `{{time}}`) | ✅ jq keys_unsorted diff 为空,key 各恰好 1 次 |
| CSS | `.scheduled-indicator` 用既有 `--amber`(#ffd60a)| ✅ 几何与 `.draft-indicator` 同族(12px chip / 8px glyph / flex-shrink 0) |

### 设计核对

- **独立标记位正确**:IIFE 位于 popout-mark/harness/pin/terminal-mark 之后、perm/active-spinner/unread/draft 互斥三元链之前——闹钟不遮蔽任何高优先级信号;mount 测试钉死同排 `.session-time` 计数不变(scheduled 行尾槽保留时间兜底)。
- **无本地滴答是对的**:到点由后端 one-shot timer drain 并广播新快照自清标识;`> now` 门只在渲染时求值属软兜底,真正的清除事件源是 drain 快照,语义一致(server-driven,无窗口期假阳)。
- **popout 不受影响**:`<Sidebar>` 在 `{!isPopout && (` 分支内,popout 无侧栏,无需处理。
- **三端**:纯呈现层增量,无新事件/binding/远程守卫;同一 `<Sidebar>` 组件路径覆盖桌面/远程浏览器/PWA 抽屉。落地记录已如实标注真 webview 肉眼观感为用户侧冒烟项。

### 测试质量

4 例 mount 测试断言锚定输出而非字段存在(chip DOM + className + svg 字形 + tooltip content + `.session-time` 计数 + 共存双 chip + 过去时刻隐藏)。i18n mock 只回显 key 导致 tooltip 断言只能锚 key 字符串,系 mock 约束下的合理锚点,不阻塞。

## 复验记录(Task #24915 环境)

| 验证项 | 结果 |
|---|---|
| `bun install`(环境 node_modules 缺失,补装 375 包)| OK |
| `bun test src/components/Sidebar src/components/QueuePanel` | **53 pass / 0 fail**(含新增 4 例)|
| `wails3 generate bindings` + `bunx tsc --noEmit` | 干净(bindings 目录 gitignored,树保持 clean)|
| zh/en i18n key 平价(jq diff)| 一致 |

## 发现的问题

无阻塞项。(仅备注:mount 测试须先有 bindings 才能过 `tsc`,CI 已有生成步骤则不受影响。)

## 下一步

- 用户侧三端肉眼冒烟(GUI / 远程浏览器 / PWA ≤768px 抽屉),尤其超长 label 截断场景下的行高表现(几何与 draft chip 同族,风险低)。
