"use client";

import { useRef, useState } from "react";
import { EChartsCanvasSurface } from "./EChartsCanvasSurface";
import { ChartExportControls } from "./ChartExportControls";
import type { ChartRendererOwner, ChartRenderModel } from "./chartRenderer";
import { quickChartKeyboardPoints, quickChartSelectionFromKeyboard, quickChartSelectionFromEvent } from "./QuickChartView.model";

export function QuickChartView({
  initialRange,
  model,
  onPointSelect,
}: {
  initialRange?: { fromSI: number; toSI: number } | null;
  model: ChartRenderModel;
  onPointSelect?: (selection: { rowIndex: number; seriesId: string; x: number; y: number }) => void;
}) {
  const exportRef = useRef<ChartRendererOwner | null>(null);
  const [keyboardCursor, setKeyboardCursor] = useState(0);
  const keyboardPoints = quickChartKeyboardPoints(model);
  const activePoint = keyboardPoints[keyboardCursor] ?? keyboardPoints[0];
  return (
    <section className="fm-quick-chart" aria-label="Quick Chart">
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
          initialRange={initialRange ? {
            fromValue: initialRange.fromSI,
            toValue: initialRange.toSI,
          } : null}
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
