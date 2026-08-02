package acp

// elicitation.go: 实现 ACP elicitation/create client 回调(ACP v1 标准协议,SDK 标 UNSTABLE)。
//
// 场景:harness(如 omp)的某些命令(/review 选模式、/fast 确认)是 interactive,在 ACP 下
// 经 elicitation/create 请求 client 用 form 收集结构化用户输入。桌面客户端有人在场,把这类
// 请求桥接成前端弹窗给用户裁决,正合适(类比 §3.4 权限裁决)。
//
// omp 的 select/confirm/input 都把单字段包装成 {type:object, properties:{value:<schema>},
// required:["value"]}(字段名固定 "value")。本实现支持多字段 form(逐字段渲染),单字段是其
// 特例;url-based elicitation 暂不支持(omp 不用,返回 decline 让 harness 自行处理)。

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/coder/acp-go-sdk"
)

// ElicitationPrompt 是发给前端的 elicitation 请求(扁平化,JSON 友好)。
type ElicitationPrompt struct {
	ID        string             `json:"id"`
	SessionID string             `json:"sessionId"`
	Message   string             `json:"message"`        // harness 给的人话提示(如 "Review Mode")
	Fields    []ElicitationField `json:"fields"`         // 表单字段(omp 单字段 "value")
}

// ElicitationField 一个表单字段(从 JSON Schema property 扁平化)。
// 前端按 Type 渲染:string→input、string+Enum→select、boolean→checkbox/confirm。
type ElicitationField struct {
	Name        string   `json:"name"`                  // property key(omp 固定 "value")
	Type        string   `json:"type"`                  // string | boolean(ACP schema 限定 primitive)
	Title       string   `json:"title,omitempty"`       // 字段标题(可选)
	Description string   `json:"description,omitempty"` // 字段说明(可选,omp input 用 description 当 placeholder)
	Enum        []string `json:"enum,omitempty"`        // string 的枚举(select 下拉)
	Default     string   `json:"default,omitempty"`     // 默认值(string 时)
	Required    bool     `json:"required,omitempty"`
}

// UnstableCreateElicitation 实现 acp.Client 回调:agent 请求结构化用户输入。
// form → 扁平化推前端等响应(带超时兜底);url → 暂不支持,decline。
func (h *Handler) UnstableCreateElicitation(ctx context.Context, req acp.UnstableCreateElicitationRequest) (acp.UnstableCreateElicitationResponse, error) {
	// url-based:暂不支持(omp 不用)。decline 让 harness 知道 client 不处理,自行降级。
	if req.Form == nil {
		slog.Warn("elicitation url mode unsupported, declining", "url", req.Url != nil)
		return acp.UnstableCreateElicitationResponse{
			Decline: &acp.UnstableCreateElicitationDecline{Action: "decline"},
		}, nil
	}

	fields, err := elicitFields(req.Form.RequestedSchema)
	if err != nil {
		slog.Warn("elicitation schema unparseable, declining", "err", err)
		return acp.UnstableCreateElicitationResponse{
			Decline: &acp.UnstableCreateElicitationDecline{Action: "decline"},
		}, nil
	}

	h.mu.Lock()
	h.elicitSeq++
	id := fmt.Sprintf("elicit-%d-%d", time.Now().UnixNano(), h.elicitSeq)
	p := &pendingElicitation{
		prompt: ElicitationPrompt{
			ID:      id,
			Message: req.Form.Message,
			Fields:  fields,
			// SessionID 由 service 的 onElicitation 回调对齐到 db sessionID(同 onPermission 模式)。
		},
		response: make(chan ElicitationResponse, 1),
	}
	h.pendingElicit[id] = p
	h.mu.Unlock()

	slog.Info("elicitation prompt dispatched", "id", id, "fields", len(fields), "message", req.Form.Message)
	h.dispatchElicitation(p.prompt)

	// 等用户响应 / ctx 取消 / 超时降级。复用 permTTL(语义一致:用户交互超时预算)。
	timer := time.NewTimer(h.permTTL)
	defer timer.Stop()
	select {
	case resp := <-p.response:
		slog.Info("elicitation responded", "id", id, "action", resp.Action)
		return elicitResponseToSDK(resp), nil
	case <-ctx.Done():
		h.removePendingElicit(id)
		slog.Warn("elicitation cancelled by context", "id", id, "err", ctx.Err())
		return acp.UnstableCreateElicitationResponse{
			Cancel: &acp.UnstableCreateElicitationCancel{Action: "cancel"},
		}, ctx.Err()
	case <-timer.C:
		// 超时降级:decline(让 harness 优雅降级,如 omp review 走 undefined 后整体返空;
		// 比 cancel 更中性 —— cancel 可能被 harness 当作"用户中止 turn")。
		h.removePendingElicit(id)
		slog.Warn("elicitation timed out, degrade to decline", "id", id)
		return acp.UnstableCreateElicitationResponse{
			Decline: &acp.UnstableCreateElicitationDecline{Action: "decline"},
		}, nil
	}
}

// dispatchElicitation 通知前端弹窗(service → Wails3 event),带 panic 恢复(同 dispatchPrompt)。
func (h *Handler) dispatchElicitation(prompt ElicitationPrompt) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("elicitation dispatch panic recovered", "id", prompt.ID, "panic", r)
		}
	}()
	if h.OnElicitation != nil {
		h.OnElicitation(prompt)
	}
}

func (h *Handler) removePendingElicit(id string) {
	h.mu.Lock()
	delete(h.pendingElicit, id)
	h.mu.Unlock()
}

// elicitResponseToSDK 把前端响应转成 SDK 响应 union。
func elicitResponseToSDK(resp ElicitationResponse) acp.UnstableCreateElicitationResponse {
	switch resp.Action {
	case "accept":
		return acp.UnstableCreateElicitationResponse{
			Accept: &acp.UnstableCreateElicitationAccept{Action: "accept", Content: resp.Content},
		}
	case "decline":
		return acp.UnstableCreateElicitationResponse{
			Decline: &acp.UnstableCreateElicitationDecline{Action: "decline"},
		}
	default: // cancel / 未知
		return acp.UnstableCreateElicitationResponse{
			Cancel: &acp.UnstableCreateElicitationCancel{Action: "cancel"},
		}
	}
}

// elicitFields 从 ACP ElicitationSchema(type=object + properties)扁平化为字段列表。
// 按字段名排序保证前端渲染顺序稳定(properties 是 map,无序)。只认 primitive:string/boolean。
// 未知/复合类型字段原样透传 type(前端降级显示)。
func elicitFields(schema acp.UnstableElicitationSchema) ([]ElicitationField, error) {
	props := schema.Properties
	if len(props) == 0 {
		return nil, fmt.Errorf("empty properties")
	}
	names := make([]string, 0, len(props))
	for k := range props {
		names = append(names, k)
	}
	sort.Strings(names)
	required := map[string]bool{}
	for _, r := range schema.Required {
		required[r] = true
	}
	fields := make([]ElicitationField, 0, len(names))
	for _, name := range names {
		f, ok := elicitField(name, props[name], required[name])
		if !ok {
			continue
		}
		fields = append(fields, f)
	}
	if len(fields) == 0 {
		return nil, fmt.Errorf("no renderable fields")
	}
	return fields, nil
}

// elicitField 解析单个 property(必须是 {type:string|boolean, ...})。非 map 或缺 type 跳过。
func elicitField(name string, prop any, required bool) (ElicitationField, bool) {
	m, ok := prop.(map[string]any)
	if !ok {
		return ElicitationField{}, false
	}
	typ, _ := m["type"].(string)
	if typ == "" {
		return ElicitationField{}, false
	}
	f := ElicitationField{Name: name, Type: typ, Required: required}
	if t, ok := m["title"].(string); ok {
		f.Title = t
	}
	if d, ok := m["description"].(string); ok {
		f.Description = d
	}
	if d, ok := m["default"].(string); ok {
		f.Default = d
	}
	// enum:string 类型的可选值(select 下拉)。
	if arr, ok := m["enum"].([]any); ok {
		for _, e := range arr {
			if s, ok := e.(string); ok {
				f.Enum = append(f.Enum, s)
			}
		}
	}
	return f, true
}
