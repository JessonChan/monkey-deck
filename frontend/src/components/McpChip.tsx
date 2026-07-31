import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import type { McpServer } from "../../bindings/github.com/jessonchan/monkey-deck/internal/store/models";
import { Plug } from "lucide-react";

// 聊天头部 MCP 只读状态 chip(§4.4):显示当前 session 选用了哪几个 MCP server。
//
// 诚实边界:只反映「选了哪些」(创建时定死,session_mcp),不反映实时连接状态——
// ACP 不回报 MCP 连接状态,OMP 也不映射进 SessionUpdate(见 docs/worklog)。
// 选中 0 个 → 不渲染 chip(无 MCP 的 session 不占位)。
export default function McpChip({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const [servers, setServers] = useState<McpServer[]>([]);

  useEffect(() => {
    let alive = true;
    if (!sessionId) return;
    ChatService.GetSessionMcpServers(sessionId)
      .then((list) => { if (alive) setServers(list ?? []); })
      .catch(() => { if (alive) setServers([]); });
    return () => { alive = false; };
  }, [sessionId]);

  if (servers.length === 0) return null;
  const names = servers.map((s) => s.name).join(", ");
  return (
    <span
      className="chat-model"
      data-testid="chat-mcp-chip"
      data-tooltip-id="md-tip"
      data-tooltip-content={t("chat.mcpChipTip", { names })}
      style={{ display: "inline-flex", alignItems: "center", gap: 3 }}
    >
      <Plug size={12} />
      {servers.length}
    </span>
  );
}
