// 单色线性图标(SF Symbols 风格),用 currentColor,替换 emoji —— 这是原生感的关键。
// stroke 1.6,圆角端点,24x24 viewBox,通过 size 控制大小。
import type { CSSProperties } from "react";

export type IconName =
  | "folder" | "plus" | "bubble" | "send" | "stop" | "paperclip" | "slash"
  | "copy" | "check" | "close" | "sparkles" | "tool" | "brain" | "shield"
  | "chevron" | "monkey" | "hash" | "more";

interface Props {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

const P: Record<IconName, string> = {
  folder: "M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
  plus: "M12 5v14M5 12h14",
  bubble: "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z",
  send: "M12 19V5M5 12l7-7 7 7",
  stop: "M6 6h12v12H6z",
  paperclip: "M21 11.5 12.5 20a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10.5 18a2 2 0 0 1-3-3l7.5-7.5",
  slash: "M16 4 8 20",
  copy: "M9 9h10v10H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1",
  check: "M20 6 9 17l-5-5",
  close: "M18 6 6 18M6 6l12 12",
  sparkles: "M12 3l1.6 4.6L18 9l-4.4 1.4L12 15l-1.6-4.6L6 9l4.4-1.4L12 3ZM19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14Z",
  tool: "M14.7 6.3a3.5 3.5 0 0 0-4.6 4.6L4 17l3 3 6.1-6.1a3.5 3.5 0 0 0 4.6-4.6l-2.3 2.3-2-2 2.3-2.3Z",
  brain: "M9 3a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 3 3V3ZM15 3a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3V3Z",
  shield: "M12 3 5 6v5c0 4 3 7 7 8 4-1 7-4 7-8V6l-7-3Z",
  chevron: "M6 9l6 6 6-6",
  hash: "M4 9h16M4 15h16M10 3 8 21M16 3l-2 18",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  monkey: "M12 4a6 6 0 0 0-6 6c0 1.5.6 2.9 1.5 4A4 4 0 0 0 12 22a4 4 0 0 0 4.5-8A6 6 0 0 0 12 4ZM9 13h.01M15 13h.01M9 17c1 1 4 1 6 0",
};

export default function Icon({ name, size = 16, className, style }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path d={P[name]} />
    </svg>
  );
}
