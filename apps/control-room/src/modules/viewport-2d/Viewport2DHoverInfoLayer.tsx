"use client";

import type { CrossSectionQualityMetric } from "@/kernel/api/apiTypes";

import {
  formatViewport2DTooltipContent,
  resolveViewport2DTooltipPosition,
  type Viewport2DPolygonHover,
} from "./viewport2dHoverTooltip";

export function Viewport2DHoverInfoLayer({
  hover,
  metric,
}: {
  hover: Viewport2DPolygonHover | null;
  metric: CrossSectionQualityMetric;
}) {
  if (!hover) return null;

  const content = formatViewport2DTooltipContent(hover, metric);
  const position = resolveViewport2DTooltipPosition(hover.pointer);

  return (
    <div
      className="fm-viewport-2d__hover-info"
      style={{ left: position.left, top: position.top }}
    >
      <div className="fm-viewport-2d__hover-title">{content.title}</div>
      <dl className="fm-viewport-2d__hover-rows">
        {content.rows.map((row) => (
          <div className="fm-viewport-2d__hover-row" key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
