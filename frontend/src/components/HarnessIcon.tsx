import { useState } from "react";
import { Bot } from "lucide-react";

interface Props {
  // harness ID(如 "omp" / "opencode"),对应 frontend/public/harness-icons/<id>.<ext>。
  // 空 / undefined / 未知(无对应图标)→ lucide Bot 兜底。
  harnessId?: string;
  // 渲染尺寸(px,正方形)。默认 14。
  size?: number;
  // 透传 className(放在 <img> / <Bot> 上),供调用方做布局/主题微调。
  className?: string;
  // 可选 hover tooltip 文本(§4.5 状态指示需解释);走 react-tooltip 的 md-tip 实例
  // (data-tooltip-id="md-tip" + data-tooltip-content)。空 = 无 tooltip。
  tooltip?: string;
}

// 按优先级尝试的图标扩展名(§5.3 KISS:文件名 = ID,扩展名随源项目原图格式 svg/png,
// 无中间映射表)。逐个尝试,某扩展名 404 / 加载失败则落到下一个,全部失败 → Bot 兜底。
const ICON_EXTS = ["svg", "png"] as const;

// HarnessIcon:按 harness ID 渲染对应官方品牌图标。
//
// 设计依据:
//   - 命名约定(assets/harness-icons/README.md):文件名 = harness.Harness.ID,
//     扩展名随源项目原图格式(svg / png),前端按 harness ID 直接归并取图(§5.3 KISS,
//     无中间映射表)。
//   - 兜底:未知 / 第三方 harness(没匹配到 <id>.<ext>)用 lucide Bot 中性图标,
//     不报错(assets/harness-icons/README.md 已约定的兜底策略)。
//   - 资源来源:assets/harness-icons/<id>.<ext>(单一事实源)在构建时镜像到
//     frontend/public/harness-icons/<id>.<ext>,Vite 把 public/ 整目录拷进 dist 根,
//     运行时经 /harness-icons/<id>.<ext> 访问。
//
// 加载失败(网络/路径错/文件缺)→ 依次尝试其余扩展名,全失败 → 切到 Bot,避免破图。
export default function HarnessIcon({ harnessId, size = 14, className, tooltip }: Props) {
  const [extIdx, setExtIdx] = useState(0);
  const [failed, setFailed] = useState(false);
  const tipAttrs = tooltip
    ? { "data-tooltip-id": "md-tip", "data-tooltip-content": tooltip }
    : {};

  if (!harnessId || failed) {
    return <Bot size={size} className={className} {...tipAttrs} />;
  }

  const handleError = () => {
    if (extIdx < ICON_EXTS.length - 1) {
      setExtIdx(extIdx + 1);
    } else {
      setFailed(true);
    }
  };

  return (
    <img
      key={ICON_EXTS[extIdx]}
      src={`/harness-icons/${harnessId}.${ICON_EXTS[extIdx]}`}
      width={size}
      height={size}
      className={className}
      alt={harnessId}
      onError={handleError}
      draggable={false}
      {...tipAttrs}
    />
  );
}
