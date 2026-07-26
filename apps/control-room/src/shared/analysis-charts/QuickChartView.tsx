"use client";

import { useRef, useState } from "react";
import { EChartsCanvasSurface } from "./EChartsCanvasSurface";
import { ChartExportControls } from "./ChartExportControls";
import type { ChartRendererOwner, ChartRenderModel } from "./chartRenderer";

export function QuickChartView({
  model,
  onPointSelect,
}: {
  model: ChartRenderModel;
  onPointSelect?: (selection: { rowIndex: number; seriesId: string; x: number; y: number }) => void;
}) {
  const exportRef = useRef<ChartRendererOwner | null>(null);
  const [keyboardCursor, setKeyboardCursor] = useState(0);
  const keyboardPoints = quickChartKeyboardPoints(model);
  const activePoint = keyboardPoints[keyboardCursor] ?? keyboardPoints[0];
  return (
    <section className="fm-quick-chart" aria-label="Inspector Quick Chart">
      <div
        aria-label={activePoint
          ? `Quick Chart cursor ${activePoint.seriesId}, row ${activePoint.rowIndex}, x ${activePoint.x}, y ${activePoint.y}`
          : "Quick Chart cursor, no samples"}
        className="fm-quick-chart__keyboard-surface"
        onKeyDown={(event) => {
          const next = quickChartSelectionFromKeyboard(
            event.key,
            keyboardCursor,
            keyboardPoints,
          );
          if (!next) return;
          event.preventDefault();
          setKeyboardCursor(next.cursor);
          onPointSelect?.(next.selection);
        }}
        role="application"
        tabIndex={0}
      >
        <EChartsCanvasSurface
          className="fm-quick-chart__canvas"
          exportRef={exportRef}
          model={model}
          onClick={(event) => {
            const selection = quickChartSelectionFromEvent(event, model);
            if (selection) onPointSelect?.(selection);
          }}
        />
      </div>
      <ChartExportControls model={model} rendererRef={exportRef} />
    </section>
  );
}

type QuickChartSelection = {
  rowIndex: number;
  seriesId: string;
  x: number;
  y: number;
};

export function quickChartKeyboardPoints(model: ChartRenderModel): QuickChartSelection[] {
  return model.series.flatMap((series) =>
    series.points.map((point) => ({
      rowIndex: point.rowIndex,
      seriesId: series.id,
      x: point.x,
      y: point.y,
    })),
  );
}

export function quickChartSelectionFromKeyboard(
  key: string,
  cursor: number,
  points: QuickChartSelection[],
): { cursor: number; selection: QuickChartSelection } | null {
  if (points.length === 0) return null;
  const current = Math.min(points.length - 1, Math.max(0, cursor));
  const next = key === "ArrowRight" || key === "ArrowDown"
    ? Math.min(points.length - 1, current + 1)
    : key === "ArrowLeft" || key === "ArrowUp"
      ? Math.max(0, current - 1)
      : key === "Home"
        ? 0
        : key === "End"
          ? points.length - 1
          : key === "Enter" || key === " "
            ? current
            : null;
  return next === null ? null : { cursor: next, selection: points[next] };
}

export function quickChartSelectionFromEvent(
  event: unknown,
  model: ChartRenderModel,
): { rowIndex: number; seriesId: string; x: number; y: number } | null {
  if (!event || typeof event !== "object") return null;
  const candidate = event as { data?: unknown; seriesIndex?: unknown };
  if (!Array.isArray(candidate.data) || typeof candidate.seriesIndex !== "number") return null;
  const [x, y, rowIndex] = candidate.data;
  const series = model.series[candidate.seriesIndex];
  return series && typeof x === "number" && typeof y === "number" && Number.isInteger(rowIndex)
    ? { rowIndex, seriesId: series.id, x, y }
    : null;
}
