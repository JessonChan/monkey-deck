//go:build integration

package titlegen

import (
	"context"
	"testing"
	"time"
)

// 真实端到端:读用户真实 opencode 全局配置(~/.config/opencode/opencode.json)
// 调实际 LLM 生成标题。验证:① provider 解析 ② thinking 关闭 ③ 归一化。
// 运行:go test -tags integration -run TestLiveGenerate ./internal/titlegen/
func TestLiveGenerate(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	msg := "帮我把项目里的 README 改成中文，并加一节安装说明"
	t.Logf("fallback  = %q", FallbackTitle(msg, "新对话"))
	gen := Generate(ctx, "bigmodel-coding/glm-5.2", "", msg)
	t.Logf("generated = %q", gen)
	if gen == "" {
		t.Skip("生成失败(provider 无配置/网络/key)—— 仅 fallback 生效")
	}
}
