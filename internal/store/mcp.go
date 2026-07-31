package store

// mcp.go: MCP server 全局 catalog + per-session 选择的持久化(AGENTS.md §1.5 本地是真相)。
//
// 作用域分层(见 0014/0015 迁移注释):
//   - mcp_servers(本文件):全局定义 + 默认开关。用户手填或导入 harness JSON。
//   - session_mcp:某次会话「用哪几个」(catalog 子集),NewSession 勾选时落库。
//
// store 只管 CRUD(§2.1:SQL 唯一入口);「转成 ACP McpServer」在 internal/acp,
// 「解析 opencode/OMP JSON 导入」在 internal/mcp。本包不依赖二者,避免反向依赖。

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
)

// McpServer 一行 catalog:MCP server 的定义 + 默认开关。
// transport 决定哪些字段有意义:stdio→Command/Args/Env;http/sse→URL/Headers。
type McpServer struct {
	ID             string            `json:"id"`
	Name           string            `json:"name"`
	Transport      string            `json:"transport"` // "stdio" | "http" | "sse"
	Command        string            `json:"command"`   // stdio
	Args           []string          `json:"args"`      // stdio
	Env            map[string]string `json:"env"`       // stdio (plaintext; UI masks)
	URL            string            `json:"url"`       // http/sse
	Headers        map[string]string `json:"headers"`   // http/sse (plaintext; UI masks)
	DefaultEnabled bool              `json:"defaultEnabled"`
	CreatedAt      int64             `json:"createdAt"`
	UpdatedAt      int64             `json:"updatedAt"`
}

// mcpServerRow 是 DB 行(args/env/headers 以 JSON 文本存)。与 McpServer 的差别仅在三个 JSON 列。
type mcpServerRow struct {
	ID             string
	Name           string
	Transport      string
	Command        string
	Args           string // JSON array
	Env            string // JSON map
	URL            string
	Headers        string // JSON map
	DefaultEnabled int
	CreatedAt      int64
	UpdatedAt      int64
}

func (r mcpServerRow) toModel() (McpServer, error) {
	m := McpServer{
		ID:             r.ID,
		Name:           r.Name,
		Transport:      r.Transport,
		Command:        r.Command,
		URL:            r.URL,
		DefaultEnabled: r.DefaultEnabled != 0,
		CreatedAt:      r.CreatedAt,
		UpdatedAt:      r.UpdatedAt,
		Args:           []string{},
		Env:            map[string]string{},
		Headers:        map[string]string{},
	}
	if r.Args != "" {
		if err := json.Unmarshal([]byte(r.Args), &m.Args); err != nil {
			return McpServer{}, fmt.Errorf("mcp args json: %w", err)
		}
	}
	if r.Env != "" {
		if err := json.Unmarshal([]byte(r.Env), &m.Env); err != nil {
			return McpServer{}, fmt.Errorf("mcp env json: %w", err)
		}
	}
	if r.Headers != "" {
		if err := json.Unmarshal([]byte(r.Headers), &m.Headers); err != nil {
			return McpServer{}, fmt.Errorf("mcp headers json: %w", err)
		}
	}
	return m, nil
}

// CreateMcpServer 新建一行 catalog。id 由本方法生成(uuid)。name 重复 → SQLite UNIQUE 报错。
// transport 必须是 stdio/http/sse;调用方据此填对应字段(无关字段传零值即可)。
func (s *Store) CreateMcpServer(ctx context.Context, m McpServer) (*McpServer, error) {
	if m.Name == "" {
		return nil, fmt.Errorf("create mcp server: name is required")
	}
	switch m.Transport {
	case "stdio", "http", "sse":
	default:
		return nil, fmt.Errorf("create mcp server: invalid transport %q", m.Transport)
	}
	if m.ID == "" {
		m.ID = uuid.NewString()
	}
	now := now()
	m.CreatedAt = now
	m.UpdatedAt = now
	row, err := toRow(m)
	if err != nil {
		return nil, err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO mcp_servers
		(id,name,transport,command,args,env,url,headers,default_enabled,created_at,updated_at)
		VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
		row.ID, row.Name, row.Transport, row.Command, row.Args, row.Env, row.URL, row.Headers,
		boolToInt(m.DefaultEnabled), m.CreatedAt, m.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("create mcp server: %w", err)
	}
	return &m, nil
}

// ListMcpServers 列出全部 catalog 行(name 升序,稳定顺序便于 UI)。
func (s *Store) ListMcpServers(ctx context.Context) ([]McpServer, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,name,transport,command,args,env,url,headers,
		default_enabled,created_at,updated_at FROM mcp_servers ORDER BY name ASC`)
	if err != nil {
		return nil, fmt.Errorf("list mcp servers: %w", err)
	}
	defer rows.Close()
	out := []McpServer{}
	for rows.Next() {
		var r mcpServerRow
		if err := rows.Scan(&r.ID, &r.Name, &r.Transport, &r.Command, &r.Args, &r.Env, &r.URL,
			&r.Headers, &r.DefaultEnabled, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, fmt.Errorf("list mcp servers scan: %w", err)
		}
		m, err := r.toModel()
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// ListDefaultMcpServers 列出 default_enabled=1 的 catalog 行(NewSession 预勾来源)。
func (s *Store) ListDefaultMcpServers(ctx context.Context) ([]McpServer, error) {
	all, err := s.ListMcpServers(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]McpServer, 0, len(all))
	for _, m := range all {
		if m.DefaultEnabled {
			out = append(out, m)
		}
	}
	return out, nil
}

// GetMcpServer 取单行;不存在返回 nil, nil。
func (s *Store) GetMcpServer(ctx context.Context, id string) (*McpServer, error) {
	var r mcpServerRow
	err := s.db.QueryRowContext(ctx, `SELECT id,name,transport,command,args,env,url,headers,
		default_enabled,created_at,updated_at FROM mcp_servers WHERE id=?`, id).
		Scan(&r.ID, &r.Name, &r.Transport, &r.Command, &r.Args, &r.Env, &r.URL, &r.Headers,
			&r.DefaultEnabled, &r.CreatedAt, &r.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get mcp server: %w", err)
	}
	m, err := r.toModel()
	if err != nil {
		return nil, err
	}
	return &m, nil
}

// UpdateMcpServer 全量更新一行(按 id;name 不可改——它是 server 标识,改了等于换 server)。
// 实际允许改 transport/连接字段/default_enabled。返回受影响行数:0=id 不存在。
func (s *Store) UpdateMcpServer(ctx context.Context, m McpServer) (int64, error) {
	switch m.Transport {
	case "stdio", "http", "sse":
	default:
		return 0, fmt.Errorf("update mcp server: invalid transport %q", m.Transport)
	}
	m.UpdatedAt = now()
	row, err := toRow(m)
	if err != nil {
		return 0, err
	}
	res, err := s.db.ExecContext(ctx, `UPDATE mcp_servers SET
		transport=?,command=?,args=?,env=?,url=?,headers=?,default_enabled=?,updated_at=?
		WHERE id=?`,
		row.Transport, row.Command, row.Args, row.Env, row.URL, row.Headers,
		boolToInt(m.DefaultEnabled), m.UpdatedAt, m.ID)
	if err != nil {
		return 0, fmt.Errorf("update mcp server: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// DeleteMcpServer 删除一行 + 同步清理 session_mcp 里对它的引用(幂等)。
func (s *Store) DeleteMcpServer(ctx context.Context, id string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("delete mcp server begin: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM session_mcp WHERE mcp_server_id=?`, id); err != nil {
		return fmt.Errorf("delete mcp server refs: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM mcp_servers WHERE id=?`, id); err != nil {
		return fmt.Errorf("delete mcp server: %w", err)
	}
	return tx.Commit()
}

// SetSessionMcp 全量重写某 session 的 MCP 选择:删旧 → 插新(传入的 id 列表)。
// 空列表 = 该 session 不用任何 MCP(合法)。在 CreateSession 时调用。
func (s *Store) SetSessionMcp(ctx context.Context, sessionID string, serverIDs []string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("set session mcp begin: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM session_mcp WHERE session_id=?`, sessionID); err != nil {
		return fmt.Errorf("set session mcp clear: %w", err)
	}
	for _, id := range serverIDs {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO session_mcp(session_id,mcp_server_id) VALUES(?,?)`, sessionID, id); err != nil {
			return fmt.Errorf("set session mcp insert: %w", err)
		}
	}
	return tx.Commit()
}

// GetSessionMcpServers 取某 session 选用的 MCP server(关联 catalog,按 name 升序)。
// 是 startLive 注入 session/new|resume 的数据源。session 无选择 → 空切片(非 nil)。
func (s *Store) GetSessionMcpServers(ctx context.Context, sessionID string) ([]McpServer, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT m.id,m.name,m.transport,m.command,m.args,m.env,
		m.url,m.headers,m.default_enabled,m.created_at,m.updated_at
		FROM session_mcp s JOIN mcp_servers m ON m.id=s.mcp_server_id
		WHERE s.session_id=? ORDER BY m.name ASC`, sessionID)
	if err != nil {
		return nil, fmt.Errorf("get session mcp: %w", err)
	}
	defer rows.Close()
	out := []McpServer{}
	for rows.Next() {
		var r mcpServerRow
		if err := rows.Scan(&r.ID, &r.Name, &r.Transport, &r.Command, &r.Args, &r.Env, &r.URL,
			&r.Headers, &r.DefaultEnabled, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, fmt.Errorf("get session mcp scan: %w", err)
		}
		m, err := r.toModel()
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// toRow 把 McpServer 序列化成 DB 行(args/env/headers → JSON 文本)。id/name/时间戳原样保留。
func toRow(m McpServer) (mcpServerRow, error) {
	args := m.Args
	if args == nil {
		args = []string{}
	}
	env := m.Env
	if env == nil {
		env = map[string]string{}
	}
	headers := m.Headers
	if headers == nil {
		headers = map[string]string{}
	}
	argsB, err := json.Marshal(args)
	if err != nil {
		return mcpServerRow{}, fmt.Errorf("mcp args marshal: %w", err)
	}
	envB, err := json.Marshal(env)
	if err != nil {
		return mcpServerRow{}, fmt.Errorf("mcp env marshal: %w", err)
	}
	headersB, err := json.Marshal(headers)
	if err != nil {
		return mcpServerRow{}, fmt.Errorf("mcp headers marshal: %w", err)
	}
	return mcpServerRow{
		ID: m.ID, Name: m.Name, Transport: m.Transport, Command: m.Command,
		Args: string(argsB), Env: string(envB), URL: m.URL, Headers: string(headersB),
		DefaultEnabled: boolToInt(m.DefaultEnabled), CreatedAt: m.CreatedAt, UpdatedAt: m.UpdatedAt,
	}, nil
}
