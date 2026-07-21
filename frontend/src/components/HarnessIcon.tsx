import { useState } from "react";
import { Bot } from "lucide-react";

interface Props {
  // harness ID(如 "omp" / "opencode"),对应 frontend/public/harness-icons/<id>.svg。
  // 空 / undefined / 未知(无对应 SVG)→ lucide Bot 兜底。
  harnessId?: string;
  // 渲染尺寸(px,正方形)。默认 14。
  size?: number;
  // 透传 className(放在 <img> / <Bot> 上),供调用方做布局/主题微调。
  className?: string;
  // 可选 hover tooltip 文本(§4.5 状态指示需解释);走 react-tooltip 的 md-tip 实例
  // (data-tooltip-id="md-tip" + data-tooltip-content)。空 = 无 tooltip。
  tooltip?: string;
}

// HarnessIcon:按 harness ID 渲染对应官方品牌图标。
//
// 设计依据:
//   - 命名约定(assets/harness-icons/README.md):文件名 = harness.Harness.ID,
//     前端按 harness ID 直接归并取图(§5.3 KISS,无中间映射表)。
//   - 兜底:未知 / 第三方 harness(没匹配到 <id>.svg)用 lucide Bot 中性图标,
//     不报错(assets/harness-icons/README.md 已约定的兜底策略)。
//   - 资源来源:assets/harness-icons/<id>.svg(单一事实源)在构建时镜像到
//     frontend/public/harness-icons/<id>.svg,Vite 把 public/ 整目录拷进 dist 根,
//     运行时经 /harness-icons/<id>.svg 访问。
//
// 加载失败(网络/路径错/文件缺)→ onError 翻 failed 标志 → 切到 Bot,避免破图。
export default function HarnessIcon({ harnessId, size = 14, className, tooltip }: Props) {
  const [failed, setFailed] = useState(false);
  const tipAttrs = tooltip
    ? { "data-tooltip-id": "md-tip", "data-tooltip-content": tooltip }
    : {};

  if (!harnessId || failed) {
    return <Bot size={size} className={className} {...tipAttrs} />;
  }

  return (
    <img
      src={`/harness-icons/${harnessId}.svg`}
      width={size}
      height={size}
      className={className}
      alt={harnessId}
      onError={() => setFailed(true)}
      draggable={false}
      {...tipAttrs}
    />
  );
}
