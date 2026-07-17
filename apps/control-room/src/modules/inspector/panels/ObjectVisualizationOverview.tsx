import type { ReactNode } from "react";

import { InspectorGroup } from "../primitives/InspectorGroup";
import { InspectorMetricStrip } from "../primitives/InspectorMetricStrip";

export interface ObjectVisualizationOverviewProps {
  advanced: ReactNode;
  camera: ReactNode;
  clipping: ReactNode;
  dataState: string;
  display: ReactNode;
  enabledPassCount: number;
  meshState: string;
  quantitySource: string;
  surfaceColoring: ReactNode;
  vectors: ReactNode;
}

export function ObjectVisualizationOverview({
  advanced,
  camera,
  clipping,
  dataState,
  display,
  enabledPassCount,
  meshState,
  quantitySource,
  surfaceColoring,
  vectors,
}: ObjectVisualizationOverviewProps) {
  return (
    <div
      className="fm-object-visualization-overview grid min-w-0 gap-[var(--fm-inspector-group-gap)] [container-type:inline-size]"
      data-slot="object-visualization-overview"
    >
      <InspectorMetricStrip
        metrics={[
          { label: "Display Passes", value: `${enabledPassCount} enabled` },
          { label: "Quantity Source", value: quantitySource },
          {
            label: "Mesh Readiness",
            tone: meshState === "Ready" ? "success" : "degraded",
            value: meshState,
          },
          {
            label: "Data State",
            tone: dataState === "Live" ? "success" : "neutral",
            value: dataState,
          },
        ]}
      />

      <InspectorGroup title="Display">{display}</InspectorGroup>
      {surfaceColoring}
      {vectors}

      <InspectorGroup badge="Section: Off" collapsible defaultOpen={false} title="Clipping & Section">
        {clipping}
      </InspectorGroup>
      <InspectorGroup badge="Perspective: Auto" collapsible defaultOpen={false} title="Camera & View">
        {camera}
      </InspectorGroup>
      <InspectorGroup badge="Rendering" collapsible defaultOpen={false} title="Advanced">
        {advanced}
      </InspectorGroup>
    </div>
  );
}
