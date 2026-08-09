import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import type { McpServer } from "../../bindings/github.com/jessonchan/monkey-deck/internal/store/models";
import { Plug } from "lucide-react";

// Read-only MCP status chip (§4.4): shows which MCP servers the current session selected.
// Lives in Composer compose-tools alongside branch/history chips (relocated from ChatView
// header — see issue #115). Styling matches the compose-tools chip family (compose-mcp).
//
// Honest boundary: only reflects "which were picked" (pinned at creation, session_mcp), not
// real-time connection status — ACP doesn't report MCP connection state, OMP doesn't map it
// into SessionUpdate (see docs/worklog). 0 selected → chip not rendered (no placeholder).
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
      className="compose-mcp"
      data-testid="chat-mcp-chip"
      data-tooltip-id="md-tip"
      data-tooltip-content={t("chat.mcpChipTip", { names })}
      data-tooltip-place="top"
    >
      <Plug size={11} />
      {servers.length}
    </span>
  );
}
