// useTerminal:把一个(由 registry 持有的)xterm 实例 attach 到容器上。
// xterm 实例与 scrollback 跨组件卸载保留(切 session 不丢):registry 持有实例,
// TerminalView 卸载只 detach 不 dispose,切回再 attach 同一实例。
import { useEffect, useRef } from "react";
import { acquireTerminal, attachTerminal, detachTerminal, fitTerminal, focusTerminal } from "../lib/termRegistry";

export interface TerminalHandle {
  containerRef: React.RefObject<HTMLDivElement | null>;
  fit: () => void;
  focus: () => void;
}

export function useTerminal(id: string, onExit: () => void): TerminalHandle {
  const containerRef = useRef<HTMLDivElement>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // 创建或取已有实例 + 挂到当前容器。
    acquireTerminal(id, onExitRef.current);
    attachTerminal(id, container);

    // 容器尺寸变化 → fit(折叠/detach 态跳过)。
    const ro = new ResizeObserver(() => {
      if (container.clientHeight < 10 || container.clientWidth < 10) return;
      fitTerminal(id);
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      detachTerminal(id); // 只脱离容器,不 dispose:实例与 scrollback 留在 registry
    };
  }, [id]);

  const fit = () => fitTerminal(id);
  const focus = () => focusTerminal(id);
  return { containerRef, fit, focus };
}
