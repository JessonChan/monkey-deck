package harness

import (
	"path/filepath"
	"strings"
	"testing"
)

// TestRegistry 校验受支持 harness 注册表的基础不变量(§2.1)。
func TestRegistry(t *testing.T) {
	if len(Supported) < 2 {
		t.Fatalf("expected at least 2 harnesses, got %d", len(Supported))
	}
	seen := map[string]bool{}
	for _, h := range Supported {
		if h.ID == "" || h.Name == "" || h.Command == "" {
			t.Fatalf("harness has empty field: %+v", h)
		}
		if seen[h.ID] {
			t.Fatalf("duplicate harness id: %s", h.ID)
		}
		seen[h.ID] = true
	}
	for _, id := range []string{"omp", "opencode"} {
		if !seen[id] {
			t.Fatalf("expected harness %s in Supported", id)
		}
	}
	if Supported[0].ID != DefaultID {
		t.Fatalf("first Supported harness must be default: got %q, want %q", Supported[0].ID, DefaultID)
	}
}

// TestSupportedIcons 校验每个 Supported harness 的 Icon 字段:
//   - 非空(已知 harness 都内置了官方图标,见 assets/harness-icons/);
//   - 路径形如 "assets/harness-icons/<id>.<ext>"(文件名 = ID,扩展名随源项目原图格式 svg/png,
//     见 assets/harness-icons/README.md 单一约定);
//   - 文件名(去扩展名)与 harness ID 对齐(§5.3 KISS:命名约定即不变量,不引入映射表)。
//
// 不读文件系统(那是资源层子卡交付物;模型层只校验路径契约,不假设文件存在)。
func TestSupportedIcons(t *testing.T) {
	const iconDir = "assets/harness-icons/"
	allowedExts := map[string]bool{".svg": true, ".png": true}
	for _, h := range Supported {
		if h.Icon == "" {
			t.Errorf("harness %q: Icon is empty; expected official icon path", h.ID)
			continue
		}
		if !strings.HasPrefix(h.Icon, iconDir) {
			t.Errorf("harness %q: Icon %q must start with %q", h.ID, h.Icon, iconDir)
		}
		// 文件名(去扩展名)必须等于 ID;扩展名须在白名单(svg/png)。
		ext := filepath.Ext(h.Icon)
		if !allowedExts[ext] {
			t.Errorf("harness %q: Icon %q has unsupported extension %q (want one of .svg/.png)", h.ID, h.Icon, ext)
		}
		base := strings.TrimSuffix(h.Icon, ext)
		const idPrefix = "assets/harness-icons/"
		if got := strings.TrimPrefix(base, idPrefix); got != h.ID {
			t.Errorf("harness %q: Icon filename %q must equal ID %q", h.ID, got, h.ID)
		}
		// 路径清洁性:不应出现 Windows 反斜杠 / 重复斜杠(filepathClean 兼容跨平台)。
		if cleaned := filepath.Clean(h.Icon); cleaned != h.Icon {
			t.Errorf("harness %q: Icon %q is not clean (got %q)", h.ID, h.Icon, cleaned)
		}
	}
}

// TestIconByKnownHarnesses 专项校验 omp / opencode 两个内置 harness 的 Icon 值。
// 锚定具体值,改路径或新增 harness 时此处会显式失败,提醒同步前端 / 资源层。
func TestIconByKnownHarnesses(t *testing.T) {
	want := map[string]string{
		"omp":      "assets/harness-icons/omp.png",
		"opencode": "assets/harness-icons/opencode.svg",
	}
	got := map[string]string{}
	for _, h := range Supported {
		got[h.ID] = h.Icon
	}
	for id, w := range want {
		if g, ok := got[id]; !ok {
			t.Errorf("harness %q missing from Supported", id)
		} else if g != w {
			t.Errorf("harness %q: Icon = %q, want %q", id, g, w)
		}
	}
}

func TestNormalizeAndCommand(t *testing.T) {
	// 已知 id 原样返回。
	if got := Normalize("opencode"); got != "opencode" {
		t.Fatalf(`Normalize("opencode")=%q, want "opencode"`, got)
	}
	// 空 / 未知回退默认(omp)。
	if got := Normalize(""); got != DefaultID {
		t.Fatalf(`Normalize("")=%q, want %q`, got, DefaultID)
	}
	if got := Normalize("bogus"); got != DefaultID {
		t.Fatalf(`Normalize("bogus")=%q, want %q`, got, DefaultID)
	}
	// Command 解析 + 未知回退默认(omp)。
	if got := Command("opencode"); got != "opencode acp" {
		t.Fatalf(`Command("opencode")=%q, want "opencode acp"`, got)
	}
	if got := Command("bogus"); got != "omp acp" {
		t.Fatalf(`Command("bogus")=%q, want "omp acp"`, got)
	}
}
