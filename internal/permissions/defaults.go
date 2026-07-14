package permissions

// DefaultRules 返回开箱默认规则集(§3.4「只读 allow、写/执行 ask、危险模式 deny」)。
// 顺序即优先级(前面的先判定)。调用方据此写库(sort_order = 下标)。
//
// 设计:
//  1. 最先判定「危险命令 deny」——即使后续有宽泛的 allow,也不会让 rm -rf 漏过。
//  2. 只读类(read/search/fetch)→ allow:agent 反复读代码无需反复确认。
//  3. 写类(edit/delete/move)→ ask:改动有副作用,保留人工裁决。
//  4. 命令执行(execute)→ ask:bash 默认需确认(危险模式已被第 1 条 deny 截走)。
//  5. 兜底未匹配的 → ask(fallback,在 Engine.Decide 里实现,不入库)。
func DefaultRules() []Rule {
	return []Rule{
		{
			ID:             "default-deny-dangerous",
			ToolName:       "",
			ActionType:     ActionExec,
			PathPattern:    "",
			CommandPattern: dangerousCommandRegex(),
			Level:          LevelDeny,
			SortOrder:      0,
			Enabled:        true,
		},
		{
			ID:         "default-allow-read",
			ToolName:   "",
			ActionType: ActionRead,
			Level:      LevelAllow,
			SortOrder:  1,
			Enabled:    true,
		},
		{
			ID:         "default-ask-write",
			ToolName:   "",
			ActionType: ActionWrite,
			Level:      LevelAsk,
			SortOrder:  2,
			Enabled:    true,
		},
		{
			ID:         "default-ask-exec",
			ToolName:   "",
			ActionType: ActionExec,
			Level:      LevelAsk,
			SortOrder:  3,
			Enabled:    true,
		},
	}
}

// dangerousCommandRegex 返回「危险命令」默认正则(大小写不敏)。
// 覆盖常见不可逆破坏:
//   - rm -rf / rm -fr 家族(同一 flag cluster 同时含 r 与 f,含 -R 变体)
//   - fork 炸弹 :(){:|:&};:
//   - mkfs.*  (格式化磁盘)
//   - dd ... of=/dev/...  (裸写块设备)
//   - > /dev/sd*  (重定向覆写块设备)
//
// 用户可在设置里改/删。偏保守(宁可误报 deny 让用户放行,不可漏放 rm -rf)。
func dangerousCommandRegex() string {
	return `(?i)\brm\s+-\w*r\w*f|\brm\s+-\w*f\w*r|:\s*\(\)\s*\{\s*:\|:&\s*\};|mkfs\b|dd\s+.*of=/dev/|>\s*/dev/sd`
}
