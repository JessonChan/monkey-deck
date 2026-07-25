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

	t.Run("image data emits ContentBlockImage", func(t *testing.T) {
		blocks := buildPromptBlocks("see pic", []Attachment{{Name: "shot.png", Data: "BASE64DATA", MimeType: "image/png"}}, "/work")
		if len(blocks) != 2 {
			t.Fatalf("expected 2 blocks, got %d", len(blocks))
		}
		img := blocks[1].Image
		if img == nil {
			t.Fatalf("second block should be an image block, got %+v", blocks[1])
		}
		if img.Data != "BASE64DATA" {
			t.Fatalf("image data = %q, want BASE64DATA", img.Data)
		}
		if img.MimeType != "image/png" {
			t.Fatalf("image mimeType = %q, want image/png", img.MimeType)
		}
		if !strings.HasSuffix(img.Type, "image") {
			t.Fatalf("image type = %q, want suffix image", img.Type)
		}
		// Image 块不应同时是 ResourceLink。
		if blocks[1].ResourceLink != nil {
			t.Fatalf("image block should not be a resource link")
		}
	})

	t.Run("image data without mimeType defaults to png", func(t *testing.T) {
		blocks := buildPromptBlocks("", []Attachment{{Name: "x", Data: "D"}}, "/w")
		if blocks[1].Image == nil || blocks[1].Image.MimeType != "image/png" {
			t.Fatalf("expected default image/png, got %+v", blocks[1].Image)
		}
	})

	t.Run("image and resource attachments mixed", func(t *testing.T) {
		blocks := buildPromptBlocks("", []Attachment{
			{Path: "src/a.go", Name: "a.go"},
			{Name: "p.png", Data: "D", MimeType: "image/png"},
		}, "/work")
		if len(blocks) != 3 {
			t.Fatalf("expected 3 blocks (text+file+image), got %d", len(blocks))
		}
		if blocks[1].ResourceLink == nil {
			t.Fatalf("second block should be resource link")
		}
		if blocks[2].Image == nil {
			t.Fatalf("third block should be image")
		}
	})

	// --- Kind 扩展:audio / resource(任务 #23076) ---

	t.Run("audio attachment emits ContentBlockAudio", func(t *testing.T) {
		blocks := buildPromptBlocks("hear this", []Attachment{{
			Kind: "audio", Name: "rec.webm", Data: "BASE64AUDIO", MimeType: "audio/webm",
		}}, "/work")
		if len(blocks) != 2 {
			t.Fatalf("expected 2 blocks, got %d", len(blocks))
		}
		au := blocks[1].Audio
		if au == nil {
			t.Fatalf("second block should be an audio block, got %+v", blocks[1])
		}
		if au.Data != "BASE64AUDIO" {
			t.Fatalf("audio data = %q, want BASE64AUDIO", au.Data)
		}
		if au.MimeType != "audio/webm" {
			t.Fatalf("audio mimeType = %q, want audio/webm", au.MimeType)
		}
		if !strings.HasSuffix(au.Type, "audio") {
			t.Fatalf("audio type = %q, want suffix audio", au.Type)
		}
		// 不应同时是别的块类型。
		if blocks[1].Image != nil || blocks[1].ResourceLink != nil || blocks[1].Resource != nil {
			t.Fatalf("audio block should not carry other variants")
		}
	})

	t.Run("audio without mimeType defaults to wav", func(t *testing.T) {
		blocks := buildPromptBlocks("", []Attachment{{Kind: "audio", Name: "r", Data: "D"}}, "/w")
		if blocks[1].Audio == nil || blocks[1].Audio.MimeType != "audio/wav" {
			t.Fatalf("expected default audio/wav, got %+v", blocks[1].Audio)
		}
	})

	t.Run("resource text attachment emits ContentBlockResource TextResourceContents", func(t *testing.T) {
		blocks := buildPromptBlocks("ctx", []Attachment{{
			Kind: "resource", Name: "snippet.go", Text: "package main", MimeType: "text/x-go",
			URI: "file:///work/snippet.go",
		}}, "/work")
		if len(blocks) != 2 {
			t.Fatalf("expected 2 blocks, got %d", len(blocks))
		}
		res := blocks[1].Resource
		if res == nil {
			t.Fatalf("second block should be a resource block, got %+v", blocks[1])
		}
		if !strings.HasSuffix(res.Type, "resource") {
			t.Fatalf("resource type = %q, want suffix resource", res.Type)
		}
		tr := res.Resource.TextResourceContents
		if tr == nil {
			t.Fatalf("expected TextResourceContents variant, got %+v", res.Resource)
		}
		if tr.Text != "package main" {
			t.Fatalf("text = %q, want 'package main'", tr.Text)
		}
		if tr.Uri != "file:///work/snippet.go" {
			t.Fatalf("uri = %q, want file:///work/snippet.go", tr.Uri)
		}
		if tr.MimeType == nil || *tr.MimeType != "text/x-go" {
			t.Fatalf("mimeType = %v, want text/x-go", tr.MimeType)
		}
		if res.Resource.BlobResourceContents != nil {
			t.Fatalf("Text variant should not set BlobResourceContents")
		}
	})

	t.Run("resource blob attachment emits BlobResourceContents", func(t *testing.T) {
		blocks := buildPromptBlocks("", []Attachment{{
			Kind: "resource", Name: "bin", Data: "QkxPQg==", MimeType: "application/octet-stream",
		}}, "/work")
		res := blocks[1].Resource
		if res == nil {
			t.Fatalf("second block should be a resource block")
		}
		bl := res.Resource.BlobResourceContents
		if bl == nil {
			t.Fatalf("expected BlobResourceContents variant, got %+v", res.Resource)
		}
		if bl.Blob != "QkxPQg==" {
			t.Fatalf("blob = %q, want QkxPQg==", bl.Blob)
		}
		if bl.MimeType == nil || *bl.MimeType != "application/octet-stream" {
			t.Fatalf("mimeType = %v, want application/octet-stream", bl.MimeType)
		}
		// URI 兜底:无 URI/Path → 用 Name 生成 urn。
		if bl.Uri != "urn:monkey-deck:bin" {
			t.Fatalf("uri = %q, want urn:monkey-deck:bin", bl.Uri)
		}
	})

	t.Run("resource URI falls back to file:// from path", func(t *testing.T) {
		blocks := buildPromptBlocks("", []Attachment{{
			Kind: "resource", Path: "src/a.go", Text: "x",
		}}, "/work")
		tr := blocks[1].Resource.Resource.TextResourceContents
		if tr.Uri != "file:///work/src/a.go" {
			t.Fatalf("uri = %q, want file:///work/src/a.go", tr.Uri)
		}
	})

	t.Run("explicit Kind file still produces ResourceLink", func(t *testing.T) {
		blocks := buildPromptBlocks("", []Attachment{{Kind: "file", Path: "a/b.go", Name: "b.go"}}, "/work")
		if blocks[1].ResourceLink == nil {
			t.Fatalf("Kind=file should produce ResourceLink")
		}
		if blocks[1].ResourceLink.Uri != "file:///work/a/b.go" {
			t.Fatalf("uri = %q, want file:///work/a/b.go", blocks[1].ResourceLink.Uri)
		}
	})

	t.Run("all kinds mixed", func(t *testing.T) {
		blocks := buildPromptBlocks("hi", []Attachment{
			{Path: "f.go", Name: "f.go"},
			{Kind: "image", Name: "p.png", Data: "D", MimeType: "image/png"},
			{Kind: "audio", Name: "r.webm", Data: "D", MimeType: "audio/webm"},
			{Kind: "resource", Name: "t.txt", Text: "T"},
		}, "/work")
		if len(blocks) != 5 {
			t.Fatalf("expected 5 blocks (text+4 attachments), got %d", len(blocks))
		}
		if blocks[1].ResourceLink == nil {
			t.Fatalf("block 1 should be resource link")
		}
		if blocks[2].Image == nil {
			t.Fatalf("block 2 should be image")
		}
		if blocks[3].Audio == nil {
			t.Fatalf("block 3 should be audio")
		}
		if blocks[4].Resource == nil {
			t.Fatalf("block 4 should be resource")
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
