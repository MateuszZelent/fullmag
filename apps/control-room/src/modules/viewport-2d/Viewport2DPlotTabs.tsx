"use client";

import type { CrossSectionPlot } from "@/kernel/workspace/crossSectionWorkspace";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/Tabs";

interface Viewport2DPlotTabsProps {
  activePlotId: string | null;
  onPlotSelect: (plot: CrossSectionPlot) => void;
  plots: readonly CrossSectionPlot[];
}

export function Viewport2DPlotTabs({
  activePlotId,
  onPlotSelect,
  plots,
}: Viewport2DPlotTabsProps) {
  if (plots.length === 0) return null;

  const selectedPlotId = activePlotId ?? plots.at(-1)?.id ?? "";
  return (
    <Tabs
      className="fm-viewport-2d__tabs"
      value={selectedPlotId}
      onValueChange={(plotId) => {
        const plot = plots.find((entry) => entry.id === plotId);
        if (plot) onPlotSelect(plot);
      }}
    >
      <TabsList aria-label="2D cross-section plots">
        {plots.map((plot) => (
          <TabsTrigger
            className="fm-viewport-2d__tab"
            key={plot.id}
            value={plot.id}
          >
            <span className="fm-viewport-2d__tab-name">{plot.name}</span>
            <span className="fm-viewport-2d__tab-meta">
              {formatViewport2DPlotTabLabel(plot)}
            </span>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

export function formatViewport2DPlotTabLabel(plot: CrossSectionPlot): string {
  return `${plot.plane.toUpperCase()} ${formatPosition(plot.positionPercent)}% / ${plot.metric}`;
}

function formatPosition(positionPercent: number): string {
  return Number.isInteger(positionPercent)
    ? `${positionPercent}`
    : positionPercent.toFixed(1);
}
