package acp

import (
	"strings"
	"testing"
)

// TestBuildPromptBlocks 校验 prompt 的 ContentBlock 序列构造:
// 首块恒为 TextBlock;每个 attachment 一个 ResourceLink(file:// URI);相对路径解析进 workDir。
func TestBuildPromptBlocks(t *testing.T) {
	t.Run("text only when no attachments", func(t *testing.T) {
		blocks := buildPromptBlocks("hello", nil, "/work")
		if len(blocks) != 1 {
			t.Fatalf("expected 1 block, got %d", len(blocks))
		}
		if blocks[0].Text == nil || blocks[0].Text.Text != "hello" {
			t.Fatalf("first block should be text 'hello', got %+v", blocks[0].Text)
		}
		if blocks[0].ResourceLink != nil {
			t.Fatalf("first block should not be a resource link")
		}
	})

	t.Run("relative path resolved into workDir", func(t *testing.T) {
		blocks := buildPromptBlocks("see this", []Attachment{{Path: "src/foo.go", Name: "foo.go"}}, "/work")
		if len(blocks) != 2 {
			t.Fatalf("expected 2 blocks, got %d", len(blocks))
		}
		rl := blocks[1].ResourceLink
		if rl == nil {
			t.Fatalf("second block should be a resource link")
		}
		if rl.Name != "foo.go" {
			t.Fatalf("name = %q, want foo.go", rl.Name)
		}
		if rl.Uri != "file:///work/src/foo.go" {
			t.Fatalf("uri = %q, want file:///work/src/foo.go", rl.Uri)
		}
	})

	t.Run("absolute path used as-is", func(t *testing.T) {
		blocks := buildPromptBlocks("", []Attachment{{Path: "/abs/bar.txt"}}, "/work")
		rl := blocks[1].ResourceLink
		if rl.Uri != "file:///abs/bar.txt" {
			t.Fatalf("uri = %q, want file:///abs/bar.txt", rl.Uri)
		}
		// Name 缺省取基名。
		if rl.Name != "bar.txt" {
			t.Fatalf("default name = %q, want bar.txt", rl.Name)
		}
	})
}

// TestFileURI 校验 file:// 构造(相对/绝对路径)。
func TestFileURI(t *testing.T) {
	cases := []struct{ workDir, path, want string }{
		{"/work", "a/b.go", "file:///work/a/b.go"},
		{"/work", "/x/y.go", "file:///x/y.go"},
		{"/work", ".", "file:///work"},
	}
	for _, c := range cases {
		got := fileURI(c.workDir, c.path)
		if got != c.want {
			t.Errorf("fileURI(%q,%q) = %q, want %q", c.workDir, c.path, got, c.want)
		}
	}
	// 协议 baseline:ResourceLink 的 type 必须是 resource_link。
	blocks := buildPromptBlocks("x", []Attachment{{Path: "f", Name: "f"}}, "/w")
	if !strings.HasSuffix(blocks[1].ResourceLink.Type, "resource_link") {
		t.Errorf("resource link type = %q, want suffix resource_link", blocks[1].ResourceLink.Type)
	}
}
