// Package titlegen 为会话生成「即时兜底标题」(无 LLM)。
//
// 用途:用户发首条消息、harness 尚未生成标题前,先给侧栏一个可读标题。
// 真正的权威标题由 harness 生成、经 ACP session_info_update 推送或 session/list 读取;
// 本包只负责权威标题到达前的瞬时显示(去 markdown/命令/引号,截断 maxChars)。
//
// 归一化逻辑移植自 wesight (MIT):src/shared/cowork/sessionTitle.ts
// (buildSessionTitleContext / normalizeSessionTitleToPlainText)。
//
// === wesight MIT 版权声明 ===
// Copyright (c) freestylefly (https://github.com/freestylefly/wesight)
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
package titlegen

import (
	"regexp"
	"strings"
)

const (
	maxChars    = 50 // 标题最大字符数(wesight SESSION_TITLE_MAX_CHARS)
	maxCtxLines = 8  // 构造标题时最多取的行数
	maxCtxChars = 800
)

// --- 纯文本归一化(移植自 wesight sessionTitle.ts)---

// BuildContext 从原始输入抽取干净的上下文(去空行、压空白、限行限长)。
func BuildContext(input string) string {
	lines := strings.Split(input, "\n")
	out := make([]string, 0, maxCtxLines)
	for _, ln := range lines {
		ln = strings.TrimSpace(reWhitespace.ReplaceAllString(ln, " "))
		if ln == "" {
			continue
		}
		out = append(out, ln)
		if len(out) >= maxCtxLines {
			break
		}
	}
	s := strings.Join(out, "\n")
	if len(s) > maxCtxChars {
		s = s[:maxCtxChars]
	}
	return strings.TrimSpace(s)
}

var (
	reFenced      = regexp.MustCompile("(?s)```(?:[\\w-]+)?\\s*([\\s\\S]*?)```")
	reLink        = regexp.MustCompile(`\[([^\]]+)\]\(([^)]+)\)`)
	reImg         = regexp.MustCompile(`!\[([^\]]*)\]\(([^)]+)\)`)
	reInlineCode  = regexp.MustCompile("`([^`]+)`")
	reBoldStar    = regexp.MustCompile(`\*\*([^*]+)\*\*`)
	reBoldUnder   = regexp.MustCompile(`__([^_]+)__`)
	reItalicStar  = regexp.MustCompile(`\*([^*\n]+)\*`)
	reItalicUnder = regexp.MustCompile(`_([^_\n]+)_`)
	reStrike      = regexp.MustCompile(`~~([^~]+)~~`)
	reHeader      = regexp.MustCompile(`^\s{0,3}#{1,6}\s+`)
	reBlockquote  = regexp.MustCompile(`^\s*>\s?`)
	reUlItem      = regexp.MustCompile(`^\s*[-*+]\s+`)
	reOlItem      = regexp.MustCompile(`^\s*\d+\.\s+`)
	reMultiline   = regexp.MustCompile(`[\r\n]+`)
	reWhitespace  = regexp.MustCompile(`\s+`)
	reLabeled     = regexp.MustCompile(`^(?:title|标题)\s*[:：]\s*(.+)$`)
	reQuoteL      = regexp.MustCompile("^[\u201c\"'`\u2018]+")
	reQuoteR      = regexp.MustCompile("[\u201d\"'`\u2019]+$")
)

// Normalize 把任意文本(可能含 markdown / 标签 / 引号)归一化为纯文本标题。
// 空或归一化后仍空则返回 fallback。
func Normalize(value, fallback string) string {
	v := strings.TrimSpace(value)
	if v == "" {
		return fallback
	}
	if m := reFenced.FindStringSubmatch(v); len(m) > 1 {
		v = strings.TrimSpace(m[1])
	}
	v = reLink.ReplaceAllString(v, "$1")
	v = reImg.ReplaceAllString(v, "$1")
	v = reInlineCode.ReplaceAllString(v, "$1")
	v = reBoldStar.ReplaceAllString(v, "$1")
	v = reBoldUnder.ReplaceAllString(v, "$1")
	v = reItalicStar.ReplaceAllString(v, "$1")
	v = reItalicUnder.ReplaceAllString(v, "$1")
	v = reStrike.ReplaceAllString(v, "$1")
	lines := strings.Split(v, "\n")
	for i, ln := range lines {
		ln = reHeader.ReplaceAllString(ln, "")
		ln = reBlockquote.ReplaceAllString(ln, "")
		ln = reUlItem.ReplaceAllString(ln, "")
		ln = reOlItem.ReplaceAllString(ln, "")
		lines[i] = ln
	}
	v = strings.Join(lines, "\n")
	v = reMultiline.ReplaceAllString(v, " ")
	v = reWhitespace.ReplaceAllString(v, " ")
	v = strings.TrimSpace(v)
	if m := reLabeled.FindStringSubmatch(v); len(m) > 1 {
		v = strings.TrimSpace(m[1])
	}
	v = reQuoteL.ReplaceAllString(v, "")
	v = reQuoteR.ReplaceAllString(v, "")
	v = strings.TrimSpace(v)
	if v == "" {
		return fallback
	}
	if len([]rune(v)) > maxChars {
		v = string([]rune(v)[:maxChars])
	}
	if v == "" {
		return fallback
	}
	return v
}

// FallbackTitle 从用户输入即时生成纯文本标题(无 LLM),用于 harness 标题到达前的瞬时显示。
func FallbackTitle(input, fallback string) string {
	ctx := BuildContext(input)
	if ctx == "" {
		return fallback
	}
	return Normalize(ctx, fallback)
}
