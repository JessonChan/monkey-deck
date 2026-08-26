import CopyIconButton from "./CopyIconButton";
import type { ChatErrorView } from "../lib/errorDiag";

// ErrorCard: the chat error banner (#46 step 3). Primary line is the localized
// message from renderChatError; the optional secondary line carries the
// verbatim root cause in smaller, dimmer text (transient family). Copy copies
// both lines so users can paste the full diagnosis elsewhere.
export default function ErrorCard({ view }: { view: ChatErrorView }) {
  const copyText = view.secondary ? `${view.message}\n${view.secondary}` : view.message;
  return (
    <div className="error-bar" data-testid="error-bar-card">
      <div className="error-bar-main">
        <span className="error-bar-msg" data-testid="error-bar-msg">⚠ {view.message}</span>
        {view.secondary && (
          <span className="error-bar-secondary" data-testid="error-bar-secondary">{view.secondary}</span>
        )}
      </div>
      <CopyIconButton text={copyText} />
    </div>
  );
}
