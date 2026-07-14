// Package terminal 提供集成终端:每 session 可开多个交互式 shell(PTY),
// 供用户自由执行基础 shell 命令。与 agent 的 ACP 通道完全分离(§1.1):
// agent 永远走 ACP,这里的终端纯粹是给「屏幕前的人」用的。
//
// 后端用 creack/pty(Unix 事实标准,纯 Go)spawn 登录 shell;输出经 Wails3 event
// 推前端,输入/resize/kill 走 service binding(对齐 wails-terminal / 官方 v3 文档)。
// 生命周期:kill 时关闭 PTY master(内核向 controlling session 发 SIGHUP —— 终端模拟器
// 的标准清理路径)+ kill(-pgid) 兜底;交互式 shell 自身会 setpgid 成为组长,故按组回收。
// session 删除 / app 退出时统一清理,不留孤儿 shell。
package terminal

import (
	"context"
	"encoding/base64"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"syscall"

	"github.com/creack/pty"
	"github.com/google/uuid"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// 事件名(前端 Events.On 监听;单名 + body 带 id 派发,对齐 chat:event 模式)。
const (
	EventData = "terminal:data" // DataPayload(PTY 输出,base64)
	EventExit = "terminal:exit" // ExitPayload(进程退出码)
	// EventState 推某 session 是否仍有活跃终端(Start/Kill/退出时派发)。
	// 前端据此驱动侧栏「已开终端」图标(后端为权威,跨重启/跨 session 一致)。
	EventState = "terminal:state"
)

// DataPayload 一段 PTY 输出。Data 为 base64(前端 atob 解码后 term.write)。
type DataPayload struct {
	ID        string `json:"id"`
	SessionID string `json:"sessionId"`
	Data      string `json:"data"`
}

// ExitPayload 进程退出。
type ExitPayload struct {
	ID        string `json:"id"`
	SessionID string `json:"sessionId"`
	Code      int    `json:"code"`
}

// StatePayload 某 session 的终端存在性(前端 hasTermBySession 的权威数据源)。
type StatePayload struct {
	SessionID   string `json:"sessionId"`
	HasTerminal bool   `json:"hasTerminal"`
}

// termSession 一个活跃终端(内存态,钉在 sessionId 上)。
type termSession struct {
	id        string
	sessionID string
	ptmx      *os.File // PTY master(creack/pty 返回 *os.File)
	cmd       *exec.Cmd
	mu        sync.Mutex // 保护 exited 与 ptmx 的并发访问
	exited    bool       // 进程已退出/已被 kill;置位后 Write/Resize 静默忽略
}

// TerminalService 是前端与终端的桥梁(Wails3 service)。
// 通过 binding 暴露 Start/Write/Resize/Kill/KillSessionTerminals,通过 event 推 data/exit。
type TerminalService struct {
	mu       sync.RWMutex
	sessions map[string]*termSession // terminalId → session
	emitHook func(name string, data any)
}

// NewTerminalService 构造。
func NewTerminalService() *TerminalService {
	return &TerminalService{sessions: map[string]*termSession{}}
}

// ServiceStartup / ServiceShutdown Wails3 生命周期钩子。退出时杀掉所有终端防孤儿(§3.2)。
func (s *TerminalService) ServiceStartup(ctx context.Context, options application.ServiceOptions) error {
	return nil
}

func (s *TerminalService) ServiceShutdown() error {
	s.killAll()
	return nil
}

// Start 新建终端。cwd 由前端传(= Session.WorktreePath 或项目目录),不依赖 store,
// 保持 terminal 包自包含。返回 terminal id 供前端派发事件。
func (s *TerminalService) Start(sessionID, cwd string, cols, rows uint16) (string, error) {
	if cwd == "" {
		cwd = "."
	}
	shell := defaultShell()
	// 登录 shell:GUI 进程 PATH 贫瘠(已知坑),登录 shell 会自己 source profile 重建 PATH。
	args := loginArgs(shell)
	cmd := exec.Command(shell, args...)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	// 不设 Setpgid:macOS 上 pty.Start + Setpgid 会 EPERM;交互式 shell 自身会 setpgid
	// 成为组长,kill(-pgid) 即可按组回收(见 kill)。

	ws := &pty.Winsize{Rows: rows, Cols: cols}
	ptmx, err := pty.StartWithSize(cmd, ws)
	if err != nil {
		return "", fmt.Errorf("start pty: %w", err)
	}

	id := uuid.NewString()
	ts := &termSession{id: id, sessionID: sessionID, ptmx: ptmx, cmd: cmd}
	s.mu.Lock()
	s.sessions[id] = ts
	s.mu.Unlock()

	go s.readLoop(ts)
	slog.Info("terminal started", "id", id, "session", sessionID, "pid", cmd.Process.Pid, "cwd", cwd)
	s.emitState(sessionID) // 新终端上线:该 session 现在有终端
	return id, nil
}

// Write 前端 xterm.onData → 写入 PTY stdin。终端已退出则静默忽略(不报错)。
func (s *TerminalService) Write(id, data string) error {
	ts := s.get(id)
	if ts == nil {
		return nil
	}
	ts.mu.Lock()
	defer ts.mu.Unlock()
	if ts.exited {
		return nil
	}
	_, err := ts.ptmx.WriteString(data)
	return err
}

// Resize 前端 fit 后 → 调 PTY 尺寸。终端已退出则静默忽略。
func (s *TerminalService) Resize(id string, cols, rows uint16) error {
	ts := s.get(id)
	if ts == nil {
		return nil
	}
	ts.mu.Lock()
	defer ts.mu.Unlock()
	if ts.exited {
		return nil
	}
	return pty.Setsize(ts.ptmx, &pty.Winsize{Rows: rows, Cols: cols})
}

// Kill 关闭单个终端(tab 的 × / 中键)。
func (s *TerminalService) Kill(id string) error {
	s.mu.Lock()
	ts, ok := s.sessions[id]
	if ok {
		delete(s.sessions, id)
	}
	s.mu.Unlock()
	if !ok {
		return nil
	}
	s.kill(ts)
	s.emitState(ts.sessionID) // 可能归零:图标消失
	return nil
}

// KillSessionTerminals 关闭某 session 的全部终端。
// 前端 removeSession(删除会话)时调:session 删了、worktree 要拆,shell 必须先死。
func (s *TerminalService) KillSessionTerminals(sessionID string) {
	s.mu.Lock()
	doomed := []*termSession{}
	for id, ts := range s.sessions {
		if ts.sessionID == sessionID {
			doomed = append(doomed, ts)
			delete(s.sessions, id)
		}
	}
	s.mu.Unlock()
	for _, ts := range doomed {
		s.kill(ts)
	}
	if len(doomed) > 0 {
		s.emitState(sessionID) // 该 session 终端已全清
	}
}

// ListTerminalsBySession 返回当前有 ≥1 活跃终端的 session 集合(sessionId → true)。
// 供前端启动/打开 session 时同步侧栏图标(后端为权威状态,§5.3 尊重数据源)。
func (s *TerminalService) ListTerminalsBySession() map[string]bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]bool, len(s.sessions))
	for _, ts := range s.sessions {
		out[ts.sessionID] = true
	}
	return out
}

// readLoop 持续读 PTY 输出并推前端;读结束(EOF/出错)即收口:wait 进程、推 exit、清理。
func (s *TerminalService) readLoop(ts *termSession) {
	buf := make([]byte, 8192)
	for {
		n, err := ts.ptmx.Read(buf)
		if n > 0 {
			s.emit(EventData, DataPayload{
				ID: ts.id, SessionID: ts.sessionID,
				Data: base64.StdEncoding.EncodeToString(buf[:n]),
			})
		}
		if err != nil {
			break
		}
	}
	// 进程已结束:wait 收尸拿退出码。
	code := 0
	if werr := ts.cmd.Wait(); werr != nil {
		if ee, ok := werr.(*exec.ExitError); ok {
			code = ee.ExitCode()
		} else {
			code = -1
		}
	}
	ts.mu.Lock()
	alreadyKilled := ts.exited
	ts.exited = true
	ts.mu.Unlock()
	// 自然退出时由 readLoop 关 ptmx;被 kill 时由 kill() 关,这里跳过避免重复。
	if !alreadyKilled {
		_ = ts.ptmx.Close()
	}
	s.emit(EventExit, ExitPayload{ID: ts.id, SessionID: ts.sessionID, Code: code})
	removed := false
	s.mu.Lock()
	if _, ok := s.sessions[ts.id]; ok { // kill 路径已删时这里跳过
		delete(s.sessions, ts.id)
		removed = true
	}
	s.mu.Unlock()
	slog.Info("terminal exited", "id", ts.id, "code", code)
	// 仅当本路径真正移除时才推 state(kill 路径会自己 emitState,避免重复)。
	if removed {
		s.emitState(ts.sessionID)
	}
}

// kill 关闭 PTY + 杀进程组(§3.2 思路)。幂等:已退出则直接返回。
// 不设 Setpgid 的前提下仍可按组回收:交互式 shell 自身是组长(pgid==pid),
// 且关闭 ptmx master 会令内核向 controlling session 发 SIGHUP —— 终端模拟器的标准清理路径,
// 对终端内的 vim/前台进程同样有效。
func (s *TerminalService) kill(ts *termSession) {
	ts.mu.Lock()
	if ts.exited {
		ts.mu.Unlock()
		return
	}
	ts.exited = true
	ts.mu.Unlock()
	_ = ts.ptmx.Close() // SIGHUP 通道
	if ts.cmd.Process != nil {
		// 杀整个进程组(交互式 shell 自身会 setpgid;按组收 vim/子进程)。
		if pgid, err := syscall.Getpgid(ts.cmd.Process.Pid); err == nil {
			_ = syscall.Kill(-pgid, syscall.SIGKILL)
		} else {
			_ = ts.cmd.Process.Kill()
		}
		// 不在这里 Wait:留给 readLoop(Read 因 ptmx 关闭而 error 后自然走到 Wait)。
	}
}

// killAll app 退出兜底:杀所有活跃终端。
func (s *TerminalService) killAll() {
	s.mu.Lock()
	all := make([]*termSession, 0, len(s.sessions))
	for id, ts := range s.sessions {
		all = append(all, ts)
		delete(s.sessions, id)
	}
	s.mu.Unlock()
	for _, ts := range all {
		s.kill(ts)
	}
}

// get 取终端(线程安全)。
func (s *TerminalService) get(id string) *termSession {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.sessions[id]
}

// emit 经 Wails3 event 推前端(对齐 ChatService.emit)。测试可注入 emitHook 捕获。
func (s *TerminalService) emit(name string, data any) {
	if s.emitHook != nil {
		s.emitHook(name, data)
		return
	}
	app := application.Get()
	if app == nil {
		return
	}
	app.Event.Emit(name, data)
}

// emitState 推某 session 的终端存在性(Start/Kill/退出后调用)。
// 不变量:锁内计数该 session 的活跃终端数,据此决定 hasTerminal,锁外 emit。
// 这是侧栏图标的权威数据源(前端据此对账,不再纯靠本地内存 state)。
func (s *TerminalService) emitState(sessionID string) {
	s.mu.RLock()
	has := false
	for _, ts := range s.sessions {
		if ts.sessionID == sessionID {
			has = true
			break
		}
	}
	s.mu.RUnlock()
	s.emit(EventState, StatePayload{SessionID: sessionID, HasTerminal: has})
}

// defaultShell 取系统默认 shell。GUI 应用 $SHELL 可能空,按平台兜底。
func defaultShell() string {
	if sh := os.Getenv("SHELL"); sh != "" {
		return sh
	}
	switch runtime.GOOS {
	case "windows":
		return "powershell.exe"
	case "darwin":
		return "/bin/zsh"
	default:
		return "/bin/bash"
	}
}

// loginArgs 返回登录 shell 参数(Unix 加 -l;Windows 无此概念)。
func loginArgs(shell string) []string {
	if runtime.GOOS == "windows" {
		return nil
	}
	return []string{"-l"}
}
