import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

// Smooth collapse: grid-template-rows 0fr→1fr animates height independently (replaces the
// jarring jump of native <details>).
// The summary is rendered as a div[role=button] (not a real <button>) so that the summary
// CAN contain nested interactive controls (e.g. a copy button on tool cards). A real <button>
// cannot legally wrap another <button> (button-in-button is invalid HTML and browsers drop
// the inner button's semantics). Keyboard a11y is preserved via onKeyDown(Enter/Space).
interface Props {
  open: boolean;
  onToggle?: () => void;
  summary: ReactNode;
  children: ReactNode;
  className?: string;
  summaryClassName?: string;
}

export default function Collapsible({ open, onToggle, summary, children, className, summaryClassName }: Props) {
  const [manual, setManual] = useState<boolean | null>(null);
  // Lazy render: skip children while collapsed (less DOM + no ReactMarkdown parse). Once opened
  // we keep them so collapsing/expanding again won't flash (content stays in DOM, only CSS hides it).
  const everOpenedRef = useRef(false);
  const isOpen = manual === null ? open : manual;
  if (isOpen) everOpenedRef.current = true;
  const toggle = () => {
    setManual(!isOpen);
    onToggle?.();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Never handle key events that originated on a nested interactive element (e.g. the copy
    // button in a tool summary). Without this guard, activating that inner button with
    // Enter/Space would bubble here and (a) toggle the collapse and (b) preventDefault() would
    // suppress the button's own activation — so the copy wouldn't fire on Enter. Only the
    // summary surface itself toggles.
    if (e.target !== e.currentTarget) return;
    // Mirror native <button>: Enter / Space activates, Space's default page-scroll suppressed.
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      toggle();
    }
  };
  return (
    <div className={className}>
      <div
        className={`collapse-summary ${summaryClassName || ""}`}
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={onKeyDown}
      >
        {summary}
      </div>
      <div className={`collapse-body ${isOpen ? "open" : ""}`}>
        <div className="collapse-body-inner">{everOpenedRef.current ? children : null}</div>
      </div>
    </div>
  );
}
