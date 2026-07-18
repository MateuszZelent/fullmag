import type { ReactNode } from "react";
import {
  Box,
  Scissors,
  Camera,
  Settings2,
} from "lucide-react";

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
      className="fm-object-visualization-overview grid min-w-0 gap-3 [container-type:inline-size]"
      data-slot="object-visualization-overview"
    >
      {/* 4-column metric strip */}
      <InspectorMetricStrip
        metrics={[
          {
            label: "Display Passes",
            value: `${enabledPassCount} enabled`,
          },
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

      {/* Display section as a bordered card */}
      <div className="fm-viz-display-card">
        <InspectorGroup
          icon={<Box size={18} strokeWidth={1.5} />}
          title="Display"
          collapsible
          defaultOpen
        >
          {display}
        </InspectorGroup>
      </div>

      {/* Nav rows for remaining sections */}
      <div className="fm-viz-nav-sections">
        {surfaceColoring}
        {vectors}

        <InspectorGroup
          collapsible
          defaultOpen={false}
          icon={<Scissors size={16} strokeWidth={1.75} />}
          summary="Section: Off"
          title="Clipping & Section"
          variant="nav"
        >
          {clipping}
        </InspectorGroup>
        <InspectorGroup
          collapsible
          defaultOpen={false}
          icon={<Camera size={16} strokeWidth={1.75} />}
          summary="Perspective • Auto"
          title="Camera & View"
          variant="nav"
        >
          {camera}
        </InspectorGroup>
        <InspectorGroup
          collapsible
          defaultOpen={false}
          icon={<Settings2 size={16} strokeWidth={1.75} />}
          summary="Rendering • Performance"
          title="Advanced"
          variant="nav"
        >
          {advanced}
        </InspectorGroup>
      </div>
    </div>
  );
}
