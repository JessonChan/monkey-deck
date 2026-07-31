import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import type { McpServer } from "../../bindings/github.com/jessonchan/monkey-deck/internal/store/models";
import { Plug, Plus, Trash2, Upload, Loader2, AlertTriangle, CheckCircle2, Pencil, X } from "lucide-react";

// MCP server 全局 catalog pane(设置中心 → MCP)。
// 定义 + 默认开关 + 一键导入 harness 配置(opencode / OMP)。SQLite 唯一真相(§1.5)。
// 不发现盘上 .mcp.json:导入是一次性用户动作,文件即弃。
//
// 每次会话「用哪几个」在 NewSessionModal 勾选(预勾 = defaultEnabled=true 的);本面板不管选用。
// env/headers 用 KEY=VALUE 每行一条的文本编辑(避免裸 JSON,§4.4),UI 脱敏展示敏感值。

type Transport = "stdio" | "http" | "sse";

// 空 server 表单(新增用)。
function emptyForm(): FormData {
  return { name: "", transport: "stdio", command: "", args: "", url: "", envText: "", headersText: "", defaultEnabled: true };
}

type FormData = {
  name: string;
  transport: Transport;
  command: string;
  args: string; // space-separated
  url: string;
  envText: string; // KEY=VALUE per line
  headersText: string; // KEY=VALUE per line
  defaultEnabled: boolean;
};

// 解析 KEY=VALUE 每行一条的文本为 map。空行 / # 开头注释跳过。
function parseKV(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function toKV(map: { [_ in string]?: string } | null | undefined): string {
  if (!map) return "";
  return Object.entries(map)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

// 脱敏展示 env/headers 值:含敏感关键词的值只显示前 4 字符 + …(§4.4,抄 orca maskMcpEnv 思路)。
const SENSITIVE = /(api[_-]?key|auth|bearer|cookie|credential|password|private[_-]?key|secret|token)/i;
function maskValue(k: string, v: string): string {
  if (SENSITIVE.test(k) && v.length > 4) return v.slice(0, 4) + "…";
  return v;
}

export default function McpSettings() {
  const { t } = useTranslation();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<McpServer | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormData>(emptyForm());
  const [saving, setSaving] = useState(false);
  // err = 真实错误(红 + 三角);notice = 导入结果汇总等中性信息(无三角)。两者互斥展示。
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await ChatService.ListMcpServers();
      setServers(list ?? []);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const openAdd = () => {
    setEditing(null);
    setForm(emptyForm());
    setErr(null);
    setNotice(null);
    setFormOpen(true);
  };

  const openEdit = (s: McpServer) => {
    setEditing(s);
    setForm({
      name: s.name, transport: s.transport as Transport,
      command: s.command, args: (s.args ?? []).join(" "),
      url: s.url, envText: toKV(s.env ?? {}), headersText: toKV(s.headers ?? {}),
      defaultEnabled: s.defaultEnabled,
    });
    setErr(null);
    setNotice(null);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
    setForm(emptyForm());
  };

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const m: McpServer = {
        id: editing?.id ?? "",
        name: form.name.trim(),
        transport: form.transport,
        command: form.transport === "stdio" ? form.command.trim() : "",
        args: form.transport === "stdio" ? form.args.trim().split(/\s+/).filter(Boolean) : [],
        env: form.transport === "stdio" ? parseKV(form.envText) : {},
        url: form.transport !== "stdio" ? form.url.trim() : "",
        headers: form.transport !== "stdio" ? parseKV(form.headersText) : {},
        defaultEnabled: form.defaultEnabled,
        createdAt: editing?.createdAt ?? 0,
        updatedAt: editing?.updatedAt ?? 0,
      };
      if (editing) {
        await ChatService.UpdateMcpServer(m);
      } else {
        await ChatService.CreateMcpServer(m);
      }
      closeForm();
      await reload();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await ChatService.DeleteMcpServer(id);
      await reload();
    } catch (e) {
      setErr(String(e));
    }
  };

  const toggleDefault = async (s: McpServer) => {
    const m: McpServer = { ...s, defaultEnabled: !s.defaultEnabled };
    try {
      await ChatService.UpdateMcpServer(m);
      await reload();
    } catch (e) {
      setErr(String(e));
    }
  };

  const doImport = async () => {
    setImporting(true);
    setErr(null);
    setNotice(null);
    try {
      const res = await ChatService.ImportMcpConfig(importText);
      const parts: string[] = [];
      if (res.added?.length) parts.push(t("settings.mcp.impAdded", { n: res.added.length, names: res.added.join(", ") }));
      if (res.skipped?.length) parts.push(t("settings.mcp.impSkipped", { n: res.skipped.length, names: res.skipped.join(", ") }));
      if (res.warnings?.length) parts.push(t("settings.mcp.impWarnings") + ": " + res.warnings.join("; "));
      if (res.errors?.length) parts.push(t("settings.mcp.impErrors") + ": " + res.errors.join("; "));
      setNotice(parts.join(" · ") || t("settings.mcp.empty"));
      setImportOpen(false);
      setImportText("");
      await reload();
    } catch (e) {
      setErr(String(e));
    } finally {
      setImporting(false);
    }
  };

  const isStdio = form.transport === "stdio";

  return (
    <div className="pane">
      <div className="pane-desc">{t("settings.mcp.desc")}</div>

      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <button className="btn" onClick={openAdd} data-testid="mcp-add">
          <Plus size={13} /> {t("settings.mcp.addBtn")}
        </button>
        <button className="btn" onClick={() => { setImportOpen(true); setErr(null); setNotice(null); }} data-testid="mcp-import">
          <Upload size={13} /> {t("settings.mcp.importBtn")}
        </button>
      </div>

      {err && (
        <div className="settings-row-sub" style={{ color: "var(--danger, var(--text-muted))", marginBottom: 8 }}>
          <AlertTriangle size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />{err}
        </div>
      )}
      {!err && notice && (
        <div className="settings-row-sub" style={{ marginBottom: 8 }}>
          <CheckCircle2 size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />{notice}
        </div>
      )}

      {loading ? (
        <div className="settings-row-sub"><Loader2 size={13} className="spin" /> {t("common.loading")}</div>
      ) : servers.length === 0 ? (
        <div className="settings-row-sub">{t("settings.mcp.empty")}</div>
      ) : (
        <div className="settings-list">
          {servers.map((s) => (
            <div key={s.id} className="settings-row" data-testid={`mcp-row-${s.name}`}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="settings-row-title">
                  <Plug size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />
                  {s.name}
                  <span className="settings-row-sub" style={{ marginLeft: 8 }}>{t(`settings.mcp.transport.${s.transport}`)}</span>
                </div>
                <div className="settings-row-sub" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {s.transport === "stdio"
                    ? `${s.command} ${(s.args ?? []).join(" ")}`
                    : s.url}
                </div>
                {s.transport === "stdio" && Object.keys(s.env ?? {}).length > 0 && (
                  <div className="settings-row-sub" style={{ fontSize: 11 }}>
                    {Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${maskValue(k, String(v))}`).join("  ·  ")}
                  </div>
                )}
              </div>
              <label className="settings-inline-toggle" title={t("settings.mcp.defaultOnTip")}>
                <input type="checkbox" checked={s.defaultEnabled} onChange={() => toggleDefault(s)} data-testid={`mcp-default-${s.name}`} />
                <span className="settings-row-sub">{t("settings.mcp.defaultOn")}</span>
              </label>
              <button className="icon-btn" onClick={() => openEdit(s)} data-tooltip-id="md-tip" data-tooltip-content={t("common.edit")} data-testid={`mcp-edit-${s.name}`}>
                <Pencil size={13} />
              </button>
              <button className="icon-btn" onClick={() => remove(s.id)} data-tooltip-id="md-tip" data-tooltip-content={t("common.delete")} data-testid={`mcp-del-${s.name}`}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {formOpen && (
        <div className="modal-overlay" onClick={closeForm} style={{ zIndex: 100 }} data-testid="mcp-form-overlay">
          <div className="settings-card" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
            <div className="settings-head">
              <div className="settings-title"><Plug size={15} /><span>{editing ? t("settings.mcp.editTitle") : t("settings.mcp.addTitle")}</span></div>
              <button className="icon-btn" onClick={closeForm}><X size={15} /></button>
            </div>
            <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
              <label className="field">
                <span className="settings-row-title">{t("settings.mcp.fName")}</span>
                <input value={form.name} disabled={!!editing} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. github" data-testid="mcp-form-name" />
              </label>
              <label className="field">
                <span className="settings-row-title">{t("settings.mcp.fTransport")}</span>
                <select value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value as Transport })}>
                  <option value="stdio">{t("settings.mcp.transport.stdio")}</option>
                  <option value="http">{t("settings.mcp.transport.http")}</option>
                  <option value="sse">{t("settings.mcp.transport.sse")}</option>
                </select>
              </label>
              {isStdio ? (
                <>
                  <label className="field">
                    <span className="settings-row-title">{t("settings.mcp.fCommand")}</span>
                    <input value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="e.g. npx" data-testid="mcp-form-command" />
                  </label>
                  <label className="field">
                    <span className="settings-row-title">{t("settings.mcp.fArgs")}</span>
                    <input value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} placeholder="e.g. -y @mcp/server-github" />
                  </label>
                  <label className="field">
                    <span className="settings-row-title">{t("settings.mcp.fEnv")}</span>
                    <textarea rows={3} value={form.envText} onChange={(e) => setForm({ ...form, envText: e.target.value })} placeholder={"KEY=VALUE (per line)\nGITHUB_TOKEN=ghp_xxx"} />
                  </label>
                </>
              ) : (
                <>
                  <label className="field">
                    <span className="settings-row-title">{t("settings.mcp.fUrl")}</span>
                    <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://example.com/mcp" />
                  </label>
                  <label className="field">
                    <span className="settings-row-title">{t("settings.mcp.fHeaders")}</span>
                    <textarea rows={3} value={form.headersText} onChange={(e) => setForm({ ...form, headersText: e.target.value })} placeholder={"KEY=VALUE (per line)\nAuthorization=Bearer xxx"} />
                  </label>
                </>
              )}
              <label className="settings-inline-toggle">
                <input type="checkbox" checked={form.defaultEnabled} onChange={(e) => setForm({ ...form, defaultEnabled: e.target.checked })} />
                <span className="settings-row-sub">{t("settings.mcp.defaultOn")}</span>
              </label>
              {err && (
                <div className="settings-row-sub" style={{ color: "var(--danger, var(--text-muted))" }}>
                  <AlertTriangle size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />{err}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button className="btn" onClick={closeForm}>{t("common.cancel")}</button>
                <button className="btn primary" disabled={saving || !form.name.trim() || (isStdio ? !form.command.trim() : !form.url.trim())} onClick={save} data-testid="mcp-form-save">
                  {saving ? <Loader2 size={13} className="spin" /> : <CheckCircle2 size={13} />} {t("common.save")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {importOpen && (
        <div className="modal-overlay" onClick={() => setImportOpen(false)} style={{ zIndex: 100 }}>
          <div className="settings-card" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <div className="settings-head">
              <div className="settings-title"><Upload size={15} /><span>{t("settings.mcp.importTitle")}</span></div>
              <button className="icon-btn" onClick={() => setImportOpen(false)}><X size={15} /></button>
            </div>
            <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="settings-row-sub">{t("settings.mcp.importDesc")}</div>
              <textarea rows={10} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder='{ "mcp": { ... } }  or  { "mcpServers": { ... } }' data-testid="mcp-import-text" />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button className="btn" onClick={() => setImportOpen(false)}>{t("common.cancel")}</button>
                <button className="btn primary" disabled={importing || !importText.trim()} onClick={doImport} data-testid="mcp-import-go">
                  {importing ? <Loader2 size={13} className="spin" /> : <Upload size={13} />} {t("settings.mcp.importBtn")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
