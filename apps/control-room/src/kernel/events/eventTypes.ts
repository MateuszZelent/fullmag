import type { ModuleId, SlotId } from "../types";
import type { LayoutState } from "../layout/layoutTypes";

export type MeshSizeHistogramDistributionId =
  | "edge_length"
  | "tetra_size"
  | "volume";

export type MeshSizeHistogramHighlightScope =
  | { kind: "airbox" }
  | { kind: "all" }
  | { kind: "object"; objectId: string };

export interface MeshSizeHistogramHighlight {
  binLabel: string;
  count: number;
  distributionId: MeshSizeHistogramDistributionId;
  distributionLabel: string;
  hi: number | null;
  lo: number | null;
  scope: MeshSizeHistogramHighlightScope;
}

export interface KernelEventMap {
  "session:status-changed": {
    status: "idle" | "connecting" | "connected" | "disconnected" | "error";
  };
  "workspace:module-activated": {
    moduleId: ModuleId;
    slotId: SlotId;
  };
  "workspace:selection-changed": {
    selectionId: string | null;
    source: ModuleId;
  };
  "workspace:layout-changed": {
    state: LayoutState;
  };
  "workspace:focus-changed": {
    state: LayoutState;
  };
  "footer:tab-requested": {
    reason?: string;
    tab: "engine" | "logs" | "telemetry";
  };
  "command:submitted": {
    commandId: string;
  };
  "command:completed": {
    commandId: string;
    status: "completed" | "failed" | "cancelled";
  };
  "resource:invalidated": {
    resourceKey: string;
    revision: string | number;
  };
  "viewport:mesh-size-bin-hovered": {
    highlight: MeshSizeHistogramHighlight | null;
    source: ModuleId;
  };
}
