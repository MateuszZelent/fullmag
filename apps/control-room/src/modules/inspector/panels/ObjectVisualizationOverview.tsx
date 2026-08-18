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
  dataState: string;
  display: ReactNode;
  enabledPassCount: number;
  meshState: string;
  quantitySource: string;
  surfaceColoring: ReactNode;
  vectors: ReactNode;
}

export function VisualizationInspectorOverview({
  advanced,
  camera,
  clipping,
  context,
  dataState,
  display,
  enabledPassCount,
  meshState,
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
            summary: "Section: Off",
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
