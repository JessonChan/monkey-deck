package chat

// window.go:session 弹出独立窗口(popout)的后端实现。
//
// 类似 VS Code「move to new window」:把任意 session 提到一个独立窗口里。
// 后端负责窗口单例 + 快照中转;前端按 hash 进入 popout 模式(见 App.tsx)。
//
// 设计要点(详见讨论记录 / worklog):
//   - 单例:窗口名 popout-<sessionID>。Wails3 的 WindowManager(GetByName)就是那张表,
//     命中即 Show+Focus(不重复开),未命中才 NewWithOptions。窗口关闭后 WindowManager
//     自动移除(webview_window.go 的 WindowClosing 内置 Remove),GetByName 自然返回 false。
//   - 传参:URL hash /#popout=<sessionID>。fragment 不发后端(asset handler 只见 /),
//     前端 location.hash 读取后进入 popout 模式。标准 SPA 路由做法。
//   - 快照中转:前端 React state(items/queue/draft/plan/permission)无法跨 webview 的独立
//     JS 上下文传递。主窗口弹出前打包快照 → SaveSessionSnapshot 存后端 → popout boot 时
//     GetSessionSnapshot 取回(一次性,取后即删)作为初始 state。已落库的对话历史则直接
//     从 SQLite LoadMessages 拉(§1.5),不走快照。
//   - 关闭通知:WindowWillClose 时 emit 事件,前端据此把该 session 移出 poppedSessionIds,
//     恢复主窗口对该 session 的渲染与事件处理(详见 App.tsx 的过滤不变量)。
//
// 终端历史不走快照:后端 PTY ring buffer 是终端 scrollback 的单一真相,
// popout 新建 xterm 后调 GetTerminalScrollback 还原(见 internal/terminal/scrollback.go)。

import (
	"encoding/json"
	"fmt"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// EventPopoutChanged session 的 popout 状态变更(打开/关闭),前端据此刷新 poppedSessionIds。
const EventPopoutChanged = "chat:popout-changed"

// PopoutPayload 推给前端的 popout 状态。
type PopoutPayload struct {
	SessionID string `json:"sessionId"`
	Popped    bool   `json:"popped"` // true=已弹出到独立窗口;false=已收回
}

// popoutWindowName 窗口名(= WindowManager 单例 key)。
func popoutWindowName(sessionID string) string {
	return "popout-" + sessionID
}

// popout 窗口尺寸:右侧面板收起时 chat 独占(窄);展开 SidePanel 时加宽(宽)。
// 展开/收起右侧面板时前端调 ExpandSessionWindow/ShrinkSessionWindow 动态改窗口宽度,
// 而非挤压 ChatView(ChatView 有 minSize 保底,展开时窗口跟着变大给 SidePanel 让空间)。
const (
	popoutWindowWidthCollapsed = 860  // 右侧面板收起:chat 独占
	popoutWindowWidthExpanded  = 1180 // 右侧面板展开:chat + SidePanel
)

// OpenSessionWindow 把某 session 弹到独立窗口(单例:已存在则聚焦,否则新建)。
// 前端在调用前应先 SaveSessionSnapshot 打包当前 React state,供 popout 还原。
func (s *ChatService) OpenSessionWindow(sessionID string) error {
	app := application.Get()
	if app == nil {
		return nil // server 模式 / 无 GUI:无法开窗口,静默返回
	}
	name := popoutWindowName(sessionID)
	// 单例:已存在 → Show + Focus,不重复开。
	if win, ok := app.Window.GetByName(name); ok {
		win.Show()
		win.Focus()
		return nil
	}
	// 新建:URL hash 传参,告诉新窗口自己是 popout、显示哪个 session。
	win := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:   name,
		Title:  "monkey-deck",
		Width:    popoutWindowWidthCollapsed,
		Height:   760,
		MinWidth:  500, // 最小宽度:chat 区有 520px minSize 保底,窗口不能更窄
		MinHeight: 400,
		URL:   fmt.Sprintf("/#popout=%s", sessionID),
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 50,
			Backdrop:                application.MacBackdropNormal,
			TitleBar:                application.MacTitleBarHiddenInset,
		},
		BackgroundColour: application.NewRGB(35, 35, 35),
	})
	// 关闭 → 从 WindowManager 移除(框架已做)+ 通知前端该 session 不再 popout。
	win.OnWindowEvent(events.Mac.WindowWillClose, func(event *application.WindowEvent) {
		s.emitPopoutChanged(sessionID, false)
	})
	s.emitPopoutChanged(sessionID, true)
	return nil
}

// FocusSessionWindow 聚焦某 session 的 popout 窗口(若存在)。
// 供主窗口侧栏「已弹出」角标点击时调用:不重复开,只拉到前台。
func (s *ChatService) FocusSessionWindow(sessionID string) {
	app := application.Get()
	if app == nil {
		return
	}
	if win, ok := app.Window.GetByName(popoutWindowName(sessionID)); ok {
		win.Show()
		win.Focus()
	}
}

// CloseSessionWindow 关闭某 session 的 popout 窗口(若存在)。「移回主窗口」用。
func (s *ChatService) CloseSessionWindow(sessionID string) {
	app := application.Get()
	if app == nil {
		return
	}
	if win, ok := app.Window.GetByName(popoutWindowName(sessionID)); ok {
		win.Close() // 触发 WindowWillClose → emitPopoutChanged(false)
	}
}

// ExpandSessionWindow 加宽 popout 窗口(右侧面板展开时调)。
// 不改高度,只加宽到 popoutWindowWidthExpanded,给 SidePanel 让出空间。
func (s *ChatService) ExpandSessionWindow(sessionID string) {
	app := application.Get()
	if app == nil {
		return
	}
	if win, ok := app.Window.GetByName(popoutWindowName(sessionID)); ok {
		_, h := win.Size()
		win.SetSize(popoutWindowWidthExpanded, h)
	}
}

// ShrinkSessionWindow 缩窄 popout 窗口(右侧面板收起时调)。
func (s *ChatService) ShrinkSessionWindow(sessionID string) {
	app := application.Get()
	if app == nil {
		return
	}
	if win, ok := app.Window.GetByName(popoutWindowName(sessionID)); ok {
		_, h := win.Size()
		win.SetSize(popoutWindowWidthCollapsed, h)
	}
}

// SetSessionWindowOnTop 设置 popout 窗口的「始终置顶」状态(类似 VS Code 的置顶)。
// macOS = NSWindow level floating;Windows = HWND_TOPMOST;Linux = keep_above。
// 前端维护 onTop state(toggle 按钮),调此 binding 应用到窗口。
func (s *ChatService) SetSessionWindowOnTop(sessionID string, onTop bool) error {
	app := application.Get()
	if app == nil {
		return nil
	}
	if win, ok := app.Window.GetByName(popoutWindowName(sessionID)); ok {
		win.SetAlwaysOnTop(onTop)
	}
	return nil
}


// IsSessionWindowPopped 报告某 session 是否已弹出到独立窗口。供前端 boot 时对账。
func (s *ChatService) IsSessionWindowPopped(sessionID string) bool {
	app := application.Get()
	if app == nil {
		return false
	}
	_, ok := app.Window.GetByName(popoutWindowName(sessionID))
	return ok
}

// GetSessionProjectID 返回某 session 所属的 project ID。
// 供 popout 窗口启动时设 selectedProjectId(不依赖前端 sessionsByProject 的加载时序)。
// session 不存在时返回空串(popout effect 据此跳过 openSession)。
func (s *ChatService) GetSessionProjectID(sessionID string) (string, error) {
	se, err := s.st.GetSession(s.ctx, sessionID)
	if err != nil {
		return "", err
	}
	if se == nil {
		return "", nil
	}
	return se.ProjectID, nil
}

// --- 快照中转 ----------------------------------------------------------------

// snapshots 存「主窗口 → popout」传递的 React state 快照。
// 一次性:popout 取走即删,避免主窗口下次弹出读到陈旧快照。
var (
	snapMu       sync.Mutex
	snapshots    = map[string]json.RawMessage{} // sessionID → 快照
)

// SaveSessionSnapshot 主窗口在 OpenSessionWindow 前调用,打包当前 React state。
// snapshotJSON 是前端序列化的 JSON(items/queue/draft/livePlan/permission 等)。
func (s *ChatService) SaveSessionSnapshot(sessionID, snapshotJSON string) error {
	snapMu.Lock()
	snapshots[sessionID] = json.RawMessage(snapshotJSON)
	snapMu.Unlock()
	return nil
}

// GetSessionSnapshot popout boot 时调用,取回主窗口打包的快照并立即删除(一次性)。
// 无快照或已取走返回空串(popout 回退为纯从 SQLite 加载)。
func (s *ChatService) GetSessionSnapshot(sessionID string) (string, error) {
	snapMu.Lock()
	raw, ok := snapshots[sessionID]
	delete(snapshots, sessionID)
	snapMu.Unlock()
	if !ok {
		return "", nil
	}
	return string(raw), nil
}

// emitPopoutChanged 推 popout 状态变更。
func (s *ChatService) emitPopoutChanged(sessionID string, popped bool) {
	s.emit(EventPopoutChanged, PopoutPayload{SessionID: sessionID, Popped: popped})
}
