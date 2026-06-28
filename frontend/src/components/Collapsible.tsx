import { useState, type ReactNode } from "react";

// 丝滑折叠:用 grid-template-rows 0fr→1fr 做高度无关的展开动画(替代原生 <details> 的生硬跳变)。
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
  const isOpen = manual === null ? open : manual;
  const toggle = () => {
    setManual(!isOpen);
    onToggle?.();
  };
  return (
    <div className={className}>
      <button className={`collapse-summary ${summaryClassName || ""}`} onClick={toggle} type="button">
        {summary}
      </button>
      <div className={`collapse-body ${isOpen ? "open" : ""}`}>
        <div className="collapse-body-inner">{children}</div>
      </div>
    </div>
  );
}
