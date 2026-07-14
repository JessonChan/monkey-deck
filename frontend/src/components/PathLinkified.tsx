import { Fragment, useMemo } from "react";
import { splitByPaths } from "../lib/filePath";

// 把一段纯文本里的文件路径识别成可点击的内联链接(Task #15084)。
// 用于:ReactMarkdown 文本(段落 / 列表 / 行内代码)、工具 I/O 输出的每一行。
// 点击 onOpen(path, line?) —— 由上层路由到 FilePreviewOverlay(等价于 FilePanel.openFile)。
//
// 仅处理字符串;调用方负责把它套进 <p> / <li> / <code> / <div> 等容器。
export default function PathLinkified({
  text,
  onOpen,
}: {
  text: string;
  onOpen: (path: string, line?: number) => void;
}) {
  const parts = useMemo(() => splitByPaths(text), [text]);
  // 无路径:直接返回纯文本,避免多余 <span> 包裹(保持等宽 / 继承样式)。
  if (parts.length === 1 && parts[0].type === "text") return <>{parts[0].text}</>;
  return (
    <>
      {parts.map((p, i) =>
        p.type === "text" ? (
          <Fragment key={i}>{p.text}</Fragment>
        ) : (
          <span
            key={i}
            className="path-link"
            role="button"
            tabIndex={0}
            title={`打开 ${p.raw}`}
            data-tooltip-id="md-tip"
            data-tooltip-content={`打开预览 ${p.raw}`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onOpen(p.path, p.line);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(p.path, p.line);
              }
            }}
          >
            {p.raw}
          </span>
        )
      )}
    </>
  );
}
