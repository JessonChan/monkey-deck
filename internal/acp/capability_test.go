package acp

// capability_test.go:CapabilityMatrix / ProbeCapabilities 单测。
//
// 不真启 harness(§5.1):matrixFromInit 是纯函数,直接测;ProbeCapabilities 走
// spawn 失败路径(不存在的二进制 → spawnAndInit 报错 → 返回带 ProbeErr 的矩阵 + error,
// 不 panic、不留孤儿进程,§3.2)。同 RefreshConfig 的测试模式(TestRefreshConfigSpawnFailure)。

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/coder/acp-go-sdk"
)

// boolPtr / structPtr 辅助构造 *bool / *struct(SDK 的 session 能力位是指针,缺省 = 不支持)。

// TestMatrixFromInit 验证从 Initialize 响应抽取声明位:
//   - 全量声明(prompt/session/mcp/loadSession 各项) → 对应位全 true。
//   - 空响应(SDK 默认) → 全 false(不应误判 true)。
//   - 只声明部分(session/list 有、close 无) → 对应位精确反映。
//   - 不填 HarnessID/ProbedAt/ProbeErr/行为观测位(由 ProbeCapabilities 在生命周期内填)。
func TestMatrixFromInit(t *testing.T) {
	t.Run("all declared", func(t *testing.T) {
		initResp := acp.InitializeResponse{
			AgentCapabilities: acp.AgentCapabilities{
				LoadSession: true,
				PromptCapabilities: acp.PromptCapabilities{
					Image:           true,
					Audio:           true,
					EmbeddedContext: true,
				},
				McpCapabilities: acp.McpCapabilities{Acp: true, Http: true, Sse: true},
				SessionCapabilities: acp.SessionCapabilities{
					List:                 &acp.SessionListCapabilities{},
					Close:                &acp.SessionCloseCapabilities{},
					Resume:               &acp.SessionResumeCapabilities{},
					Delete:               &acp.SessionDeleteCapabilities{},
					Fork:                 &acp.SessionForkCapabilities{},
					AdditionalDirectories: &acp.SessionAdditionalDirectoriesCapabilities{},
				},
			},
		}
		m := matrixFromInit(initResp)
		if !m.PromptImage || !m.PromptAudio || !m.PromptEmbeddedContext {
			t.Errorf("prompt bits: image=%v audio=%v embedded=%v, want all true", m.PromptImage, m.PromptAudio, m.PromptEmbeddedContext)
		}
		if !m.LoadSession {
			t.Errorf("LoadSession=false, want true")
		}
		if !m.SessionList || !m.SessionClose || !m.SessionResume || !m.SessionDelete || !m.SessionFork || !m.AdditionalDirectories {
			t.Errorf("session bits: list=%v close=%v resume=%v delete=%v fork=%v addDirs=%v, want all true",
				m.SessionList, m.SessionClose, m.SessionResume, m.SessionDelete, m.SessionFork, m.AdditionalDirectories)
		}
		if !m.McpAcp || !m.McpHttp || !m.McpSse {
			t.Errorf("mcp bits: acp=%v http=%v sse=%v, want all true", m.McpAcp, m.McpHttp, m.McpSse)
		}
		// 声明位之外的字段不应被 matrixFromInit 填(由 ProbeCapabilities 填)。
		if m.HarnessID != "" || m.ProbeErr != "" || m.EmitsUsage || m.EmitsPlan {
			t.Errorf("matrixFromInit 应只填声明位,得到 HarnessID=%q ProbeErr=%q EmitsUsage=%v EmitsPlan=%v",
				m.HarnessID, m.ProbeErr, m.EmitsUsage, m.EmitsPlan)
		}
	})

	t.Run("none declared defaults false", func(t *testing.T) {
		// SDK 默认行为:未声明的能力位经 UnmarshalJSON 补 false / nil。
		// 这里直接构造零值 AgentCapabilities,验证 matrixFromInit 不误判。
		m := matrixFromInit(acp.InitializeResponse{})
		if m.PromptImage || m.PromptAudio || m.PromptEmbeddedContext || m.LoadSession {
			t.Errorf("prompt/loadSession bits should be false on empty init, got image=%v audio=%v embedded=%v load=%v",
				m.PromptImage, m.PromptAudio, m.PromptEmbeddedContext, m.LoadSession)
		}
		if m.SessionList || m.SessionClose || m.SessionResume || m.SessionDelete || m.SessionFork || m.AdditionalDirectories {
			t.Errorf("session bits should be false on empty init, got list=%v close=%v resume=%v delete=%v fork=%v addDirs=%v",
				m.SessionList, m.SessionClose, m.SessionResume, m.SessionDelete, m.SessionFork, m.AdditionalDirectories)
		}
		if m.McpAcp || m.McpHttp || m.McpSse {
			t.Errorf("mcp bits should be false on empty init, got acp=%v http=%v sse=%v", m.McpAcp, m.McpHttp, m.McpSse)
		}
	})

	t.Run("partial session capabilities", func(t *testing.T) {
		// 只声明 session/list,其它 session 能力位应保持 false(精确反映,不串扰)。
		initResp := acp.InitializeResponse{
			AgentCapabilities: acp.AgentCapabilities{
				SessionCapabilities: acp.SessionCapabilities{
					List: &acp.SessionListCapabilities{},
				},
			},
		}
		m := matrixFromInit(initResp)
		if !m.SessionList {
			t.Fatalf("SessionList should be true when List != nil")
		}
		if m.SessionClose || m.SessionResume || m.SessionDelete || m.SessionFork {
			t.Fatalf("其它 session 位应为 false:close=%v resume=%v delete=%v fork=%v",
				m.SessionClose, m.SessionResume, m.SessionDelete, m.SessionFork)
		}
	})
}

// TestProbeCapabilities_SpawnFailure 验证 probe harness spawn 失败的错误路径:
// harness 命令不存在 → spawnAndInit 返回 exec 错误 → ProbeCapabilities 包成
// "probe capabilities: spawn" 错误返回,不 panic、不留孤儿进程(§3.2 回收安全性)。
// 返回的矩阵 HarnessID 正确、ProbeErr 非空、ProbedAt 已填。
func TestProbeCapabilities_SpawnFailure(t *testing.T) {
	r := NewRunner("/nonexistent/harness-binary", nil)
	workDir := t.TempDir()
	before := time.Now()
	m, err := r.ProbeCapabilities(context.Background(), "test-harness", workDir, false)
	if err == nil {
		t.Fatal("expected error when harness command does not exist")
	}
	if !strings.Contains(err.Error(), "probe capabilities: spawn") {
		t.Fatalf("expected 'probe capabilities: spawn' error, got %v", err)
	}
	if m.HarnessID != "test-harness" {
		t.Fatalf("HarnessID=%q, want 'test-harness'", m.HarnessID)
	}
	if m.ProbeErr == "" {
		t.Fatalf("ProbeErr should be non-empty on spawn failure")
	}
	if m.ProbedAt.Before(before) {
		t.Fatalf("ProbedAt not set")
	}
	// 声明位应全 false(spawn 失败 = 没拿到 Initialize 响应)。
	if m.SessionList || m.PromptImage || m.LoadSession {
		t.Fatalf("声明位应全 false(spawn 失败),got list=%v image=%v load=%v", m.SessionList, m.PromptImage, m.LoadSession)
	}
}

// TestProbeCapabilities_WithProbeSpawnFailure withProbe=true 在 spawn 失败时也应安全返回
// (不进入 noop Prompt 分支),与 withProbe=false 行为一致。
func TestProbeCapabilities_WithProbeSpawnFailure(t *testing.T) {
	r := NewRunner("/nonexistent/harness-binary", nil)
	m, err := r.ProbeCapabilities(context.Background(), "h", t.TempDir(), true)
	if err == nil {
		t.Fatal("expected error on spawn failure with withProbe=true")
	}
	// 行为观测位在 spawn 失败时应为 false(没机会发 Prompt)。
	if m.EmitsUsage || m.EmitsPlan {
		t.Fatalf("EmitsUsage/EmitsPlan should be false on spawn failure, got usage=%v plan=%v", m.EmitsUsage, m.EmitsPlan)
	}
}
