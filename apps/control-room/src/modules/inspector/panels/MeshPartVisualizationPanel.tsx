"use client";

import type { InspectorPanelProps } from "../inspectorTypes";
import {
  VisualizationTargetInspectorPanel,
  type VisualizationInspectorOwner,
} from "./ObjectVisualizationPanel";

const MESH_PART_VISUALIZATION_OWNER: VisualizationInspectorOwner = {
  actionSummary: "Part visibility, render mode, vectors, wireframe, and overrides",
  capabilityDescription:
    "Uses the canonical mesh-part target and keeps part-scoped rendering separate from object and Airbox state.",
  id: "mesh-part.visualization",
  targetLabel: "Mesh part",
  title: "Mesh-part visualization",
};

export function MeshPartVisualizationPanel({ selection }: InspectorPanelProps) {
  return (
    <VisualizationTargetInspectorPanel
      owner={MESH_PART_VISUALIZATION_OWNER}
      selection={selection}
    />
  );
}
