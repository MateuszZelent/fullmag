import type { ReactNode } from "react";
import {
  Box,
  Scissors,
  Camera,
  Settings2,
} from "lucide-react";

import { InspectorOverviewFrame } from "../primitives/InspectorOverviewFrame";

export interface VisualizationInspectorOverviewProps {
  context?: ReactNode;
  advanced: ReactNode;
  camera: ReactNode;
  clipping: ReactNode;
  clippingSummary?: string;
  dataState: string;
  display: ReactNode;
  enabledPassCount: number;
  meshState: string;
  meshStateLabel?: string;
  quantitySource: string;
  surfaceColoring: ReactNode;
  vectors: ReactNode;
}

// "Supported" means the quantity can be produced for this target but no
// solve has materialized it yet; say that instead of implying data exists.
function dataStateLabel(dataState: string): string {
  return dataState === "Supported" ? "Not computed yet" : dataState;
}

export function VisualizationInspectorOverview({
  advanced,
  camera,
  clipping,
  clippingSummary = "Section: Off",
  context,
  dataState,
  display,
  enabledPassCount,
  meshState,
  meshStateLabel = "Mesh Readiness",
  quantitySource,
  surfaceColoring,
  vectors,
}: VisualizationInspectorOverviewProps) {
  return (
    <div className="fm-object-visualization-overview" data-slot="object-visualization-overview">
      <InspectorOverviewFrame
        className="fm-object-visualization-overview__frame"
        leadingSections={
          <>
            {context}
            {surfaceColoring}
            {vectors}
          </>
        }
        metrics={[
          {
            label: "Display Passes",
            value: `${enabledPassCount} enabled`,
          },
          { label: "Quantity Source", value: quantitySource },
          {
            label: meshStateLabel,
            tone: meshState === "Ready" ? "success" : "degraded",
            value: meshState,
          },
          {
            label: "Data State",
            tone: dataState === "Live" ? "success" : "neutral",
            value: dataStateLabel(dataState),
          },
        ]}
        primary={display}
        primaryClassName="fm-viz-display-card"
        primaryIcon={<Box size={18} strokeWidth={1.5} />}
        primaryTitle="Display"
        sections={[
          {
            content: clipping,
            defaultOpen: false,
            icon: <Scissors size={16} strokeWidth={1.75} />,
            id: "clipping",
            summary: clippingSummary,
            title: "Clipping & Section",
          },
          {
            content: camera,
            defaultOpen: false,
            icon: <Camera size={16} strokeWidth={1.75} />,
            id: "camera",
            summary: "Perspective • Auto",
            title: "Camera & View",
          },
          {
            content: advanced,
            defaultOpen: false,
            icon: <Settings2 size={16} strokeWidth={1.75} />,
            id: "advanced",
            summary: "Rendering • Performance",
            title: "Advanced",
          },
        ]}
        sectionsClassName="fm-viz-nav-sections"
      />
    </div>
  );
}

export const ObjectVisualizationOverview = VisualizationInspectorOverview;
