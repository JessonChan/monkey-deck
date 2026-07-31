package store

import (
	"context"
	"testing"
)

// TestMcpServerCRUD covers catalog CRUD + JSON round-trip of args/env/headers.
func TestMcpServerCRUD(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)

	// Create a stdio server with args + env.
	m, err := s.CreateMcpServer(ctx, McpServer{
		Name: "github", Transport: "stdio",
		Command: "npx", Args: []string{"-y", "@mcp/server-github"},
		Env:            map[string]string{"GITHUB_TOKEN": "ghp_xxx"},
		DefaultEnabled: true,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if m.ID == "" || m.CreatedAt == 0 {
		t.Fatalf("create did not fill id/created_at: %+v", m)
	}

	// Create an http server (default off).
	if _, err := s.CreateMcpServer(ctx, McpServer{
		Name: "my-api", Transport: "http",
		URL: "https://example.com/mcp", Headers: map[string]string{"Authorization": "Bearer t"},
		DefaultEnabled: false,
	}); err != nil {
		t.Fatalf("create http: %v", err)
	}

	// List returns both, name-sorted.
	all, err := s.ListMcpServers(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != 2 || all[0].Name != "github" || all[1].Name != "my-api" {
		t.Fatalf("list order/content wrong: %+v", all)
	}
	// JSON round-trip: args/env preserved.
	got := all[0]
	if len(got.Args) != 2 || got.Args[1] != "@mcp/server-github" || got.Env["GITHUB_TOKEN"] != "ghp_xxx" {
		t.Fatalf("args/env not round-tripped: %+v", got)
	}

	// Defaults list returns only default-enabled (github).
	defs, err := s.ListDefaultMcpServers(ctx)
	if err != nil {
		t.Fatalf("defaults: %v", err)
	}
	if len(defs) != 1 || defs[0].Name != "github" {
		t.Fatalf("defaults wrong: %+v", defs)
	}

	// Get single.
	g, err := s.GetMcpServer(ctx, m.ID)
	if err != nil || g == nil || g.Name != "github" {
		t.Fatalf("get: %v %+v", err, g)
	}
	// Get missing → nil, nil.
	if g2, err := s.GetMcpServer(ctx, "nope"); err != nil || g2 != nil {
		t.Fatalf("get missing want nil,nil: %v %+v", err, g2)
	}

	// Update: flip default off + change url-ish field (transport stays http for my-api).
	n, err := s.UpdateMcpServer(ctx, McpServer{
		ID: m.ID, Name: "github", Transport: "stdio", Command: "npx",
		Args: []string{"-y", "@mcp/server-github", "--flag"}, DefaultEnabled: false,
	})
	if err != nil || n != 1 {
		t.Fatalf("update: %v n=%d", err, n)
	}
	defs2, _ := s.ListDefaultMcpServers(ctx)
	if len(defs2) != 0 {
		t.Fatalf("after flipping default off, defaults should be empty: %+v", defs2)
	}

	// Duplicate name → error.
	if _, err := s.CreateMcpServer(ctx, McpServer{Name: "github", Transport: "stdio", Command: "x"}); err == nil {
		t.Fatalf("duplicate name should error")
	}
	// Invalid transport → error.
	if _, err := s.CreateMcpServer(ctx, McpServer{Name: "bad", Transport: "ftp"}); err == nil {
		t.Fatalf("invalid transport should error")
	}
}

// TestSessionMcp covers per-session selection + join + delete cascade.
func TestSessionMcp(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)

	// Need a real session row for the FK-like join. Create project + session.
	proj, err := s.CreateProject(ctx, "proj", "/tmp/proj", "")
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	se, err := s.CreateSession(ctx, proj.ID, "t", "m", "opencode")
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	a, _ := s.CreateMcpServer(ctx, McpServer{Name: "a", Transport: "stdio", Command: "x"})
	b, _ := s.CreateMcpServer(ctx, McpServer{Name: "b", Transport: "http", URL: "https://e", DefaultEnabled: true})

	// Empty selection → empty (non-nil) slice.
	if got, err := s.GetSessionMcpServers(ctx, se.ID); err != nil || len(got) != 0 {
		t.Fatalf("empty selection want []: %v %+v", err, got)
	}

	// Select [a, b] → join returns both, name-sorted.
	if err := s.SetSessionMcp(ctx, se.ID, []string{a.ID, b.ID}); err != nil {
		t.Fatalf("set: %v", err)
	}
	got, err := s.GetSessionMcpServers(ctx, se.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(got) != 2 || got[0].Name != "a" || got[1].Name != "b" {
		t.Fatalf("selection join wrong: %+v", got)
	}

	// Re-set to [a] only → b dropped (full rewrite semantics).
	if err := s.SetSessionMcp(ctx, se.ID, []string{a.ID}); err != nil {
		t.Fatalf("reset: %v", err)
	}
	got2, _ := s.GetSessionMcpServers(ctx, se.ID)
	if len(got2) != 1 || got2[0].Name != "a" {
		t.Fatalf("after reset want [a]: %+v", got2)
	}

	// Deleting server a cascades to session_mcp.
	if err := s.DeleteMcpServer(ctx, a.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	got3, _ := s.GetSessionMcpServers(ctx, se.ID)
	if len(got3) != 0 {
		t.Fatalf("delete should cascade-clear selection: %+v", got3)
	}
}
