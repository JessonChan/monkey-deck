import { Component, type ErrorInfo, type ReactNode } from "react";

// App-root error boundary: an uncaught render error otherwise UNMOUNTS the
// whole React tree — the window turns into an unexitable black void (observed
// 2026-08-23: a field-shape mismatch in the remote pane blanked the app; Esc,
// close, everything dead). Degrade to a recoverable card instead. Boundaries
// do NOT catch event handlers / promises — those already fail soft.
export default class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surfaced for log-based triage; render must stay cheap.
    console.error("[AppErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="app-error-boundary" data-testid="app-error-boundary">
        <div className="app-error-card">
          <div className="app-error-title">界面出错了</div>
          <div className="app-error-msg">{String(this.state.error?.message || this.state.error)}</div>
          <button type="button" className="btn primary" onClick={() => window.location.reload()}>
            重新加载
          </button>
        </div>
      </div>
    );
  }
}
