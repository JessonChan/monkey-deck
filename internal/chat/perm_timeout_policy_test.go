package chat

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/store"
)

// TestPermissionTimeoutPolicySetting 锁定 #73 权限超时策略设置:
//   - 默认 deny(出厂未配置);
//   - Set 持久化,同一 db 重建 service(= 重启)后保持;
//   - 非法/未知输入归一 deny,不会存进脏值;
//   - store 未就绪时读默认 deny、写报错(绑定层安全)。
func TestPermissionTimeoutPolicySetting(t *testing.T) {
	dir := t.TempDir()
	st, err := store.New(filepath.Join(dir, config.AppSlug+".db"))
	if err != nil {
		t.Fatal(err)
	}
	svc := NewChatService(config.TestConfig(dir))
	svc.ctx = context.Background()
	svc.st = st

	if got := svc.GetPermissionTimeoutPolicy(); got != "deny" {
		t.Fatalf("default policy = %q, want deny", got)
	}

	if err := svc.SetPermissionTimeoutPolicy("allow"); err != nil {
		t.Fatalf("SetPermissionTimeoutPolicy(allow): %v", err)
	}
	if got := svc.GetPermissionTimeoutPolicy(); got != "allow" {
		t.Fatalf("policy after set = %q, want allow", got)
	}

	// 重启保持:关库后同一 db 重建 service。
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	st2, err := store.New(filepath.Join(dir, config.AppSlug+".db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st2.Close() })
	svc2 := NewChatService(config.TestConfig(dir))
	svc2.ctx = context.Background()
	svc2.st = st2
	if got := svc2.GetPermissionTimeoutPolicy(); got != "allow" {
		t.Fatalf("policy after restart = %q, want allow (persisted)", got)
	}

	// 非法输入归一 deny(不报错、不存脏值)。
	if err := svc2.SetPermissionTimeoutPolicy("  junk "); err != nil {
		t.Fatalf("SetPermissionTimeoutPolicy(junk): %v", err)
	}
	if got := svc2.GetPermissionTimeoutPolicy(); got != "deny" {
		t.Fatalf("policy after junk input = %q, want deny", got)
	}

	// store 未就绪(handler 单测形态):读默认 deny,写显式报错而非 panic。
	if got := (&ChatService{}).GetPermissionTimeoutPolicy(); got != "deny" {
		t.Fatalf("nil-store read = %q, want deny", got)
	}
	if err := (&ChatService{}).SetPermissionTimeoutPolicy("allow"); err == nil {
		t.Fatal("nil-store Set should error, got nil")
	}
}

// TestPermissionTimeoutPolicyWiringShape 锁定 startLive 装配入参的语义:
// normalizePermTimeoutPolicy 的产出恰是 handler timeoutPolicyAllow 认识的两档——
// "allow" 放行 / "deny"(含空/未知回退)拒绝。装配代码
// `SetPermissionRecovery(acp.DefaultPermRetries, s.permissionTimeoutPolicySetting())`
// 的读侧由本测试与 acp 侧 TestPermissionWiredDefaultsDeny 两端夹住。
func TestPermissionTimeoutPolicyWiringShape(t *testing.T) {
	cases := map[string]string{
		"allow":  "allow",
		"ALLOW":  "allow",
		" allow": "allow",
		"deny":   "deny",
		"":       "deny",
		"junk":   "deny",
	}
	for in, want := range cases {
		if got := normalizePermTimeoutPolicy(in); got != want {
			t.Fatalf("normalize(%q) = %q, want %q", in, got, want)
		}
	}
}
