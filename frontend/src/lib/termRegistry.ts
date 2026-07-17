// 终端实例全局 registry:xterm 实例脱离 React 渲染树存活。
// 解决:切 session 时 TerminalView 卸载会 dispose xterm → 切回 scrollback 全丢。
// 改为:xterm 只 open 到一个持久宿主 div(随实例存活),TerminalView attach 时把宿主 div
// appendChild 进自己的容器,卸载时把宿主 div 带走(detach)——xterm.open 全程只调一次,
// 切换容器只是移动 DOM 节点,实例与缓冲完整保留。
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Events } from "@wailsio/runtime";
import * as TerminalService from "../../bindings/github.com/jessonchan/monkey-deck/internal/terminal/terminalservice";
import type { TerminalDataEvent, TerminalExitEvent } from "./terminalTypes";

export interface TermEntry {
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement; // xterm 的持久宿主(open 一次,之后靠移动它切换容器)
  attachedTo: HTMLElement | null; // 当前所在的 TerminalView 容器(null=游离)
  dead: boolean; // 进程已退出
  onExit?: () => void; // 进程退出回调(通知前端标 tab dead)
}

const registry = new Map<string, TermEntry>();

// base64 → Uint8Array(原生 atob)。
function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// acquire 取或创建某 id 的 xterm 实例。创建时建宿主 div + open + 绑定输入/事件(随实例存活)。
export function acquireTerminal(id: string, onExit?: () => void): TermEntry {
  const existing = registry.get(id);
  if (existing) return existing;

  const term = new Terminal({
    fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace",
    fontSize: 13,
    cursorBlink: true,
    // scrollback = 终端 buffer 行数上限(内存随行数×列数线性增长)。
    // 取 1000(xterm/VS Code 默认):集成终端够用,且把单终端 buffer 内存
    // 相比早期 5000 的设定收敛 5×(见 docs/worklog/2026-07-17-terminal-scrollback-shrink.md)。
    scrollback: 1000,
    theme: {
      background: "#1e1e1e",
      foreground: "#f5f5f7",
      cursor: "#98989d",
      selectionBackground: "rgba(255,255,255,0.18)",
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // 持久宿主:xterm.open 只对它调一次。attach 时把这个 div 移进当前容器。
  const host = document.createElement("div");
  host.style.width = "100%";
  host.style.height = "100%";
  term.open(host);
  const entry: TermEntry = { term, fit, host, attachedTo: null, dead: false };

  // 输入 → 后端。
  const dataDisp = term.onData((d) => { void TerminalService.Write(id, d); });

  // resize → 后端(100ms 防抖,折叠/游离态 cols/rows 为 0 时 sendResize 内过滤)。
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const sendResize = (cols: number, rows: number) => {
    if (cols < 1 || rows < 1) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { void TerminalService.Resize(id, cols, rows); }, 100);
  };
  const resizeDisp = term.onResize(({ cols, rows }) => sendResize(cols, rows));

  // 后端输出/退出事件订阅(随实例存活:游离时后端仍推数据,xterm 缓冲持续累积,重 attach 即见)。
  const offData = Events.On("terminal:data", (e: { data?: TerminalDataEvent }) => {
    if (!e.data || e.data.id !== id) return;
    term.write(decodeBase64(e.data.data));
  });
  const offExit = Events.On("terminal:exit", (e: { data?: TerminalExitEvent }) => {
    if (!e.data || e.data.id !== id) return;
    term.write(`\r\n\x1b[90m[进程已退出,代码 ${e.data.code}]\x1b[0m\r\n`);
    entry.dead = true;
    entry.onExit?.();
  });

  (entry as TermEntry & { cleanup?: () => void }).cleanup = () => {
    clearTimeout(resizeTimer);
    dataDisp.dispose();
    resizeDisp.dispose();
    offData();
    offExit();
  };

  registry.set(id, entry);
  return entry;
}

// attach 把宿主 div 移进容器(若在别处先脱离)。xterm.open 不再调,只移动 DOM。
export function attachTerminal(id: string, container: HTMLElement): TermEntry | null {
  const entry = registry.get(id);
  if (!entry) return null;
  if (entry.attachedTo === container) return entry; // 已在本容器
  // 从原容器移除(若有)。
  if (entry.attachedTo && entry.host.parentElement === entry.attachedTo) {
    entry.attachedTo.removeChild(entry.host);
  }
  container.appendChild(entry.host);
  entry.attachedTo = container;
  // 重 attach 后重算尺寸(可能换了容器,尺寸变了)。
  if (container.clientHeight >= 10 && container.clientWidth >= 10) {
    try { entry.fit.fit(); } catch {}
  }
  return entry;
}

// detach 把宿主 div 移出容器(不 dispose:实例与 scrollback 保留在 registry)。
export function detachTerminal(id: string): void {
  const entry = registry.get(id);
  if (!entry) return;
  if (entry.attachedTo && entry.host.parentElement === entry.attachedTo) {
    entry.attachedTo.removeChild(entry.host);
  }
  entry.attachedTo = null;
}

export function fitTerminal(id: string): void {
  const entry = registry.get(id);
  if (!entry) return;
  try { entry.fit.fit(); } catch {}
}

export function focusTerminal(id: string): void {
  const entry = registry.get(id);
  if (!entry) return;
  try { entry.term.focus(); } catch {}
}

// disposeTerminal 彻底销毁(关闭 tab 时调):清事件订阅 + dispose xterm + 移出 registry。
export function disposeTerminal(id: string): void {
  const entry = registry.get(id);
  if (!entry) return;
  detachTerminal(id);
  const e = entry as TermEntry & { cleanup?: () => void };
  e.cleanup?.();
  entry.term.dispose();
  registry.delete(id);
}
