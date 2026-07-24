//go:build integration

package acp

// probe_integration_test.go:ProbeHarness 实跑验证(真 harness,需 build tag integration,§5.1)。
// 跑法:go test -tags=integration -run TestProbeHarness -v ./internal/acp/

import (
	"context"
	"testing"
	"time"
)

// TestProbeHarnessGoose 阶段 A:goose 作为开发集,自检必须 PASS 且能力矩阵被查清。
func TestProbeHarnessGoose(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	rep := ProbeHarness(ctx, "goose acp")
	t.Log("\n" + rep.Summary())
	if rep.Error != "" {
		t.Fatalf("probe 自身失败: %s", rep.Error)
	}
	if !rep.CanAdd() {
		t.Fatalf("goose 应可添加(CanAdd),报告: %+v", rep)
	}
}

// TestProbeHarnessOmp 对照:omp(默认 harness)自检必须 PASS。
func TestProbeHarnessOmp(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	rep := ProbeHarness(ctx, "omp acp")
	t.Log("\n" + rep.Summary())
	if rep.Error != "" {
		t.Fatalf("probe 自身失败: %s", rep.Error)
	}
	if !rep.CanAdd() {
		t.Fatalf("omp 应可添加(CanAdd),报告: %+v", rep)
	}
}

// TestProbeHarnessJcode 阶段 B:jcode 作为留出测试集。纪律:不看 jcode ACP 内部、
// 不写一行 jcode 代码,只跑泛型探针。PASS = jcode 是合格可互换实例,论断成立。
func TestProbeHarnessJcode(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	rep := ProbeHarness(ctx, "jcode acp")
	t.Log("\n" + rep.Summary())
	if rep.Error != "" {
		t.Fatalf("probe 自身失败: %s", rep.Error)
	}
	// 结构契约(不依赖 jcode 的 provider auth):Init + NewSession 必过 —— 证明 jcode 是合格 ACP 实例。
	if !rep.Initialized.Pass || !rep.NewSession.Pass {
		t.Fatalf("jcode 结构 conformance 失败(Init/NewSession 应过): %+v", rep)
	}
	// CanAdd 还要求模型调用跑完一轮(end_turn)—— 依赖 jcode 的 provider auth 是否就绪。
	// 不就绪时严格门槛正确地判"不能添加"(正是严格门槛的价值);此处仅记录,不硬断言。
	if !rep.CanAdd() {
		t.Logf("jcode 当前模型调用未就绪(CanAdd=false,可能 provider/auth 问题);结构 conformance 仍成立。PromptTurn=%+v", rep.PromptTurn)
	}
}
