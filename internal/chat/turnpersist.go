package chat

// turnpersist.go:turn 增量落库(#125)。
//
// 模型:timeline 是唯一真相(§5.4 #5,#12),落库分两层——
//   1. 增量 flush(本文件):turn 进行中,事件弄脏 timeline 条目后 1s 防抖批量
//      UpsertTurnMessage 写库。崩溃 / 杀进程时最多丢 ~1s 流式内容,而非整轮。
//   2. 收尾 reconcile(persistTurn,本文件):turn 结束把整条 timeline 逐条 upsert
//      ——已 flush 过的行就地更新为最终全文,未 flush 的插入。幂等:无论 flush 跑了
//      几次,DB 收敛到 timeline 终态。
//
// 并发不变量(§5.3 找不变量,不堆 if):
//   - upsert 主键 = (session_id, turn_id, entry_key)。turn_id = 开启 turn 的
//     user message id,entry_key = timeline entry id(messageId 主键 / toolCallId /
//     fallback 键)。timeline 只追加不移位 → 首写定 seq,重放不重排。
//   - flush 与 reconcile 经 ls.persistMu 串行;flush 在 persistMu 临界区内重验
//     turnID(reconcile 前 runPrompt 已清 currentTurnID),陈旧快照必然 no-op,
//     不会用部分内容覆盖最终全文。
//   - 防抖是「首个脏事件后 1s 定时」(trailing throttle),不是「最后一个事件后
//     1s」——持续流式不会饿死 flush,写入间隔上界 = 1s。

import (
	"encoding/json"
	"log/slog"
	"strings"
	"time"

	"github.com/jessonchan/monkey-deck/internal/acp"
)

// turnPersistItem:一条 timeline entry 的落库形态(upsert 参数)。
type turnPersistItem struct {
	entryKey   string
	role       string
	kind       string
	content    string
	toolCallID string
}

// buildTurnItem 把 timeline entry 转成落库形态。空白消息返回 ok=false
// (与旧 persistTurn 的 skip 语义一致:空 thought/agent 段不落库)。
// 调用方须持 ls.mu(strings.Builder / toolAccum 非并发安全)。
func buildTurnItem(e *turnEntry) (turnPersistItem, bool) {
	switch e.kind {
	case "message":
		content := e.text.String()
		if strings.TrimSpace(content) == "" {
			return turnPersistItem{}, false
		}
		kind := "agent_message_chunk"
		if e.role == "thought" {
			kind = "agent_thought_chunk"
		}
		return turnPersistItem{entryKey: e.id, role: e.role, kind: kind, content: content}, true
	case "tool":
		body, _ := json.Marshal(e.tool)
		return turnPersistItem{entryKey: e.id, role: "tool", kind: "tool_call", content: string(body), toolCallID: e.tool.ID}, true
	}
	return turnPersistItem{}, false
}

// markTurnDirty 在事件弄脏某 timeline entry 后登记待写并(必要时)排防抖 flush。
// 调用方须持 ls.mu(handleEvent 内)。无在跑 turn(currentTurnID="")不登记:
// turn 结束后到达的迟到异步更新今日同样不落库(无回归),由 reconcile 全权负责终态。
func (s *ChatService) markTurnDirty(ls *liveSession, sessionID, entryID string) {
	if ls.currentTurnID == "" {
		return
	}
	if ls.flushDirty == nil {
		ls.flushDirty = map[string]struct{}{}
	}
	ls.flushDirty[entryID] = struct{}{}
	if ls.flushTimer != nil {
		return // 已有排定的 flush:窗口内继续攒脏,定时不动
	}
	turnID := ls.currentTurnID
	interval := s.turnFlushEvery
	if interval <= 0 {
		return // 未启用(防御;生产 NewChatService 默认 1s)
	}
	ls.flushTimer = time.AfterFunc(interval, func() { s.flushTurn(sessionID, ls, turnID) })
}

// flushTurn 执行一次增量落库(防抖定时器回调):串行化(persistMu)→ 重验 turn
// → 按时序快照脏条目 → 逐条 upsert。
func (s *ChatService) flushTurn(sessionID string, ls *liveSession, turnID string) {
	ls.persistMu.Lock()
	defer ls.persistMu.Unlock()
	// persistMu 临界区内重验:若等待期间 turn 已收尾(reconcile 前必清 currentTurnID),
	// 陈旧快照作废——reconcile 已写 / 将写权威终态,部分内容不得覆盖。
	items := s.takeDirtyTurnItems(ls, turnID)
	if len(items) == 0 {
		return
	}
	slog.Debug("flush turn entries", "session", sessionID, "turn", turnID, "entries", len(items))
	for _, it := range items {
		s.upsertTurnItem(sessionID, turnID, it)
	}
}

// takeDirtyTurnItems 在 ls.mu 下取出脏条目的落库快照并清脏。
// turn 已切换(≠turnID)时返回 nil(陈旧 flush no-op;不清脏,免波及新 turn 的脏集)。
func (s *ChatService) takeDirtyTurnItems(ls *liveSession, turnID string) []turnPersistItem {
	ls.mu.Lock()
	defer ls.mu.Unlock()
	ls.flushTimer = nil
	if ls.currentTurnID != turnID {
		return nil
	}
	var items []turnPersistItem
	for _, e := range ls.timeline {
		if _, ok := ls.flushDirty[e.id]; !ok {
			continue
		}
		if it, ok := buildTurnItem(e); ok {
			items = append(items, it)
		}
	}
	// 脏集整体消费(空白消息跳过后不再等重放;再弄脏会重新登记)。
	ls.flushDirty = nil
	return items
}

// upsertTurnItem 写一条(失败只记日志,不影响其余条目与主流程)。
func (s *ChatService) upsertTurnItem(sessionID, turnID string, it turnPersistItem) {
	if _, err := s.st.UpsertTurnMessage(s.ctx, sessionID, turnID, it.entryKey, it.role, it.kind, it.content, it.toolCallID); err != nil {
		slog.Warn("upsert turn entry", "session", sessionID, "turn", turnID, "entry", it.entryKey, "err", err)
	}
}

// persistTurn 收尾 reconcile(#125):turn 结束把整条 timeline 按真实时序逐条 upsert,
// 使 DB 收敛到最终全文——增量 flush 写过的行就地更新,没写过的插入。幂等:重复调用、
// 与任意次 flush 交错,结果一致。message(thought/agent)与 tool 交错写入,重开会话
// 加载历史时顺序与实时流式一一对应(§5.4 #12)。
//
// 并发:先停掉在排定的 flush 定时器并清脏(reconcile 全量覆盖脏集),再持 persistMu
// 与在途 flush 串行——后到的陈旧 flush 因 currentTurnID 已清而 no-op。
func (s *ChatService) persistTurn(ls *liveSession, sessionID, turnID string, timeline []*turnEntry) {
	if s.persistHook != nil {
		s.persistHook() // 测试钩子:在此阻塞放大收尾窗口(生产 nil,直通)
	}
	// 停掉排定的 flush 定时器并清脏(reconcile 全量覆盖脏集),同时在同一临界区
	// 快照 timeline 终态 —— Prompt 返回后仍可能有迟到 tool_call_update 并发 patch
	// toolAccum,快照须持 ls.mu。
	ls.mu.Lock()
	if ls.flushTimer != nil {
		ls.flushTimer.Stop()
		ls.flushTimer = nil
	}
	ls.flushDirty = nil
	items := make([]turnPersistItem, 0, len(timeline))
	for _, e := range timeline {
		if it, ok := buildTurnItem(e); ok {
			items = append(items, it)
		}
	}
	ls.mu.Unlock()
	// 持 persistMu 与在途 flush 串行:后到的陈旧 flush 因 currentTurnID 已清而 no-op。
	ls.persistMu.Lock()
	defer ls.persistMu.Unlock()
	for _, it := range items {
		s.upsertTurnItem(sessionID, turnID, it)
	}
}

// persistTurnPlan 把本轮 plan 最终快照写库(role='plan' message),使重开会话能回看
// 每轮 plan。空 entries 不写(无 plan 的 turn 不留痕)。turnID 存进 tool_call_id 列,
// 前端据此把 plan item 钉在对应 turn(plan 是按 turn 索引的历史快照)。
// 经 UpsertTurnMessage(entry_key="plan")幂等写:与消息同一机制,重放不重复。
func (s *ChatService) persistTurnPlan(sessionID, turnID string, entries []acp.PlanEntry) {
	if len(entries) == 0 {
		return
	}
	body, err := json.Marshal(entries)
	if err != nil {
		slog.Warn("marshal plan entries", "err", err)
		return
	}
	if _, err := s.st.UpsertTurnMessage(s.ctx, sessionID, turnID, "plan", "plan", "plan", string(body), turnID); err != nil {
		slog.Warn("persist plan", "err", err)
	}
}
