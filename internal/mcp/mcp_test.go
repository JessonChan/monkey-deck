package mcp

import (
	"reflect"
	"testing"

	"github.com/coder/acp-go-sdk"
	"github.com/jessonchan/monkey-deck/internal/store"
)

func TestToAcpServers(t *testing.T) {
	servers := []store.McpServer{
		{Name: "fs", Transport: "stdio", Command: "npx", Args: []string{"-y", "fs"}, Env: map[string]string{"K": "v"}},
		{Name: "api", Transport: "http", URL: "https://e/mcp", Headers: map[string]string{"Authorization": "Bearer x"}},
		{Name: "legacy", Transport: "sse", URL: "https://e/sse"},
	}

	// caps support http only → sse skipped.
	got, skipped := ToAcpServers(servers, acp.McpCapabilities{Http: true})
	if len(got) != 2 {
		t.Fatalf("want 2 servers (stdio+http), got %d", len(got))
	}
	if got[0].Stdio == nil || got[0].Stdio.Command != "npx" || len(got[0].Stdio.Args) != 2 {
		t.Fatalf("stdio wrong: %+v", got[0])
	}
	if got[0].Stdio.Name != "fs" {
		t.Fatalf("name not mapped from store.Name: %q", got[0].Stdio.Name)
	}
	if len(got[0].Stdio.Env) != 1 || got[0].Stdio.Env[0].Name != "K" {
		t.Fatalf("env map→array wrong: %+v", got[0].Stdio.Env)
	}
	if got[1].Http == nil || got[1].Http.Url != "https://e/mcp" || len(got[1].Http.Headers) != 1 {
		t.Fatalf("http wrong: %+v", got[1])
	}
	if len(skipped) != 1 || skipped[0] == "" {
		t.Fatalf("sse should be skipped: %+v", skipped)
	}

	// No caps → http+sse dropped, only stdio survives.
	got2, skipped2 := ToAcpServers(servers, acp.McpCapabilities{})
	if len(got2) != 1 || got2[0].Stdio == nil {
		t.Fatalf("baseline-only want 1 stdio: %+v", got2)
	}
	if len(skipped2) != 2 {
		t.Fatalf("both http+sse skipped want 2: %+v", skipped2)
	}
}

func TestImportOpencode(t *testing.T) {
	// Mirrors the user's actual ~/.config/opencode/opencode.json shape: 1 local + 3 remote.
	data := []byte(`{
		"mcp": {
			"zai-mcp-server": {
				"type": "local",
				"command": ["npx", "-y", "@z_ai/mcp-server"],
				"environment": {"Z_AI_MODE": "ZHIPU", "Z_AI_API_KEY": "k"}
			},
			"web-search": {"type": "remote", "url": "https://bigmodel/mcp", "headers": {"Authorization": "Bearer t"}}
		}
	}`)
	servers, rep, err := ImportAuto(data)
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if len(servers) != 2 || len(rep.Errors) != 0 {
		t.Fatalf("want 2 imported 0 errors: %+v %+v", servers, rep)
	}
	// Find the local one; command array split into command + args.
	var local, remote *store.McpServer
	for i := range servers {
		switch servers[i].Name {
		case "zai-mcp-server":
			local = &servers[i]
		case "web-search":
			remote = &servers[i]
		}
	}
	if local == nil || local.Transport != "stdio" || local.Command != "npx" || len(local.Args) != 2 || local.Args[1] != "@z_ai/mcp-server" {
		t.Fatalf("local command-split wrong: %+v", local)
	}
	if len(local.Env) != 2 || local.Env["Z_AI_MODE"] != "ZHIPU" {
		t.Fatalf("local environment map wrong: %+v", local.Env)
	}
	if remote == nil || remote.Transport != "http" || remote.URL != "https://bigmodel/mcp" || remote.Headers["Authorization"] != "Bearer t" {
		t.Fatalf("remote wrong: %+v", remote)
	}
}

func TestImportOmp(t *testing.T) {
	data := []byte(`{
		"mcpServers": {
			"github": {"command": "npx", "args": ["-y", "gh"], "env": {"T": "1"}},
			"myapi": {"type": "http", "url": "https://e/mcp", "headers": {"Authorization": "Bearer x"}},
			"oauthed": {"type": "http", "url": "https://e/o", "oauth": {"clientId": "c"}},
			"broken": {"type": "http"}
		}
	}`)
	servers, rep, err := ImportAuto(data)
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if len(servers) != 3 { // github, myapi, oauthed (broken missing url → error)
		t.Fatalf("want 3 parsed servers, got %d: %+v", len(servers), servers)
	}
	if len(rep.Errors) != 1 || rep.Errors[0] == "" {
		t.Fatalf("broken should be an error: %+v", rep.Errors)
	}
	// oauth field → warning.
	foundOauthWarn := false
	for _, w := range rep.Warnings {
		if w != "" {
			foundOauthWarn = true
		}
	}
	if !foundOauthWarn {
		t.Fatalf("expected oauth warning: %+v", rep.Warnings)
	}
	// stdio default type (github has no "type").
	var gh *store.McpServer
	for i := range servers {
		if servers[i].Name == "github" {
			gh = &servers[i]
		}
	}
	if gh == nil || gh.Transport != "stdio" || gh.Command != "npx" || len(gh.Args) != 2 {
		t.Fatalf("github stdio wrong: %+v", gh)
	}
}

func TestImportAutoDetectError(t *testing.T) {
	// Neither mcp nor mcpServers → error.
	if _, _, err := ImportAuto([]byte(`{"provider": {}}`)); err == nil {
		t.Fatalf("expected error for non-MCP json")
	}
	// Invalid JSON → error.
	if _, _, err := ImportAuto([]byte(`{not json`)); err == nil {
		t.Fatalf("expected error for invalid json")
	}
}

// guard against accidental signature drift in the converter's skipped-report shape.
func TestToAcpServersEmpty(t *testing.T) {
	got, skipped := ToAcpServers(nil, acp.McpCapabilities{})
	if !reflect.DeepEqual(got, []acp.McpServer{}) || len(skipped) != 0 {
		t.Fatalf("nil input want empty non-nil: %+v %+v", got, skipped)
	}
}
