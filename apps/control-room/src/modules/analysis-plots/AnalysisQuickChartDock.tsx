"use client";

import { useKernel } from "@/kernel/KernelContext";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { useChartViewportHandoff } from "@/kernel/visualization/ChartViewportHandoffController";
import { QuickChartResourceView } from "@/shared/analysis-charts/QuickChartResourceView";
import { Button } from "@/shared/ui/Button";
import { useState } from "react";

export function AnalysisQuickChartDock() {
  const kernel = useKernel();
  const selection = useSelectionSelector((state) => state);
  const handoff = useChartViewportHandoff(kernel.chartViewportHandoff);
  const isChartSelection = isQuickChartSelection(selection);
  const [pinnedSelection, setPinnedSelection] = useState<Selection | null>(null);
  const displayedSelection = pinnedSelection ?? (isChartSelection ? selection : null);

  return (
    <section className="fm-analysis-quick-chart-dock" aria-label="Analysis Quick Chart dock">
      <header className="fm-analysis-quick-chart-dock__header">
        <strong>Quick Chart</strong>
        <span>{displayedSelection?.label ?? "Select a chart or chart point"}</span>
        <span role="status">
          3D handoff: {handoff.status}
          {handoff.message ? ` — ${handoff.message}` : ""}
        </span>
        {handoff.status === "pending" ? (
          <Button
            onClick={() => kernel.chartViewportHandoff.cancel()}
            size="sm"
            type="button"
            variant="secondary"
          >
            Cancel 3D load
          </Button>
        ) : null}
        <Button
          aria-label={pinnedSelection ? "Unpin Quick Chart" : "Pin Quick Chart"}
          aria-pressed={pinnedSelection !== null}
          disabled={!displayedSelection}
          onClick={() =>
            setPinnedSelection((current) =>
              current ? null : displayedSelection,
            )
          }
          size="sm"
          type="button"
          variant="secondary"
        >
          {pinnedSelection ? "Unpin Quick Chart" : "Pin Quick Chart"}
        </Button>
      </header>
      {displayedSelection ? (
        <QuickChartResourceView selection={displayedSelection} />
      ) : (
        <div className="fm-analysis-plots__empty" role="status">
          No chart selection. Open Analysis or select a chart result.
        </div>
      )}
    </section>
  );
}

function isQuickChartSelection(selection: Selection): boolean {
  return (
    selection.ref?.type === "analysis-chart" ||
    selection.ref?.type === "analysis-chart-point"
  );
}
