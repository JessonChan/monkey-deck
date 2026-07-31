package chat

// mcp_test.go: covers the chat-service-level ImportMcpConfig (parse + dedup + create),
// complementing internal/mcp's parser tests (which cover dialect parsing only).

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/store"
)

// setupMcpService builds a minimal ChatService (store + ctx; no git/harness needed)
// for catalog/import tests. ImportMcpConfig only touches store + the mcp parser.
func setupMcpService(t *testing.T) *ChatService {
	t.Helper()
	dataDir := t.TempDir()
	dbPath := filepath.Join(dataDir, "test.db")
	st, err := store.New(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	cfg := &config.Config{DataDir: dataDir, DBPath: dbPath}
	svc := NewChatService(cfg)
	svc.ctx = context.Background()
	svc.st = st
	return svc
}

func TestImportMcpConfigAddsAndDedups(t *testing.T) {
	svc := setupMcpService(t)
	json := `{"mcp":{"fs":{"type":"local","command":["npx","-y","fs"],"environment":{"K":"v"}},
	                      "api":{"type":"remote","url":"https://e/mcp","headers":{"Authorization":"Bearer x"}}}}`

	// First import: both added.
	res, err := svc.ImportMcpConfig(json)
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if len(res.Added) != 2 || len(res.Skipped) != 0 || len(res.Errors) != 0 {
		t.Fatalf("first import want 2 added: %+v", res)
	}

	// Catalog now has 2.
	list, _ := svc.ListMcpServers()
	if len(list) != 2 {
		t.Fatalf("catalog want 2: %d", len(list))
	}

	// Second import of the same: both skipped (dedup, not overwritten, not errored).
	res2, err := svc.ImportMcpConfig(json)
	if err != nil {
		t.Fatalf("reimport: %v", err)
	}
	if len(res2.Added) != 0 || len(res2.Skipped) != 2 || len(res2.Errors) != 0 {
		t.Fatalf("reimport want 2 skipped: %+v", res2)
	}

	// Catalog still 2 (no duplicates created).
	list2, _ := svc.ListMcpServers()
	if len(list2) != 2 {
		t.Fatalf("catalog after reimport want still 2: %d", len(list2))
	}
}

func TestImportMcpConfigInvalidJSON(t *testing.T) {
	svc := setupMcpService(t)
	if _, err := svc.ImportMcpConfig(`{"provider":{}}`); err == nil {
		t.Fatalf("non-MCP json should error")
	}
	if _, err := svc.ImportMcpConfig(`{not json`); err == nil {
		t.Fatalf("invalid json should error")
	}
}
