import { useRef, useState, type ReactNode } from "react";

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
  // 懒渲染:折叠时不渲染 children(省 DOM + 省 ReactMarkdown 解析)。展开过一次后保留,
  // 这样收起再展开不会闪(content 已在 DOM 里,仅 CSS 收起)。
  const everOpenedRef = useRef(false);
  const isOpen = manual === null ? open : manual;
  if (isOpen) everOpenedRef.current = true;
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
        <div className="collapse-body-inner">{everOpenedRef.current ? children : null}</div>
      </div>
    </div>
  );
}
