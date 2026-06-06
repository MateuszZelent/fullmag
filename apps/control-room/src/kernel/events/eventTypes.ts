import type { ModuleId, SlotId } from "../types";
import type { LayoutState } from "../layout/layoutTypes";

export type MeshSizeHistogramDistributionId =
  | "edge_length"
  | "tetra_size"
  | "volume";

export type MeshHistogramMetric =
  | "characteristic_size"
  | "edge_length"
  | "gamma"
  | "sicn"
  | "volume";

interface MeshHistogramHover {
  binIndex: number;
  meshId: string;
  metric: MeshHistogramMetric;
  partId: string;
}

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
  resource: MeshHistogramHover | null;
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
  "explorer:texture-load-node-requested": {
    objectId: string;
    source: ModuleId;
  };
  "footer:tab-requested": {
    reason?: string;
    tab: "engine" | "logs" | "mesh" | "telemetry";
  };
  "mesh:build-confirm-requested": {
    commandId: "mesh.build-selected" | "mesh.build-shared-domain";
    input?: unknown;
    source: "inspector" | "palette" | "ribbon" | "test";
    sourceDetail?: string;
  };
  "mesh:build-submitted": {
    commandId: string;
    objectId?: string;
    reason: string;
    targetKind: "object_mesh" | "study_domain";
  };
  "mesh:topology-rendered": {
    meshRevision: number | string;
    rendererId: string;
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
  "telemetry:scalar-sample": {
    revision: string | number;
    row: Record<string, number>;
    runId: string | null;
    sessionId: string;
    step: number;
    time: number;
  };
  "charts:add-series-requested": {
    columnId: string;
    source: ModuleId;
    tableId: string;
  };
  "charts:series-selected": {
    chartId: string;
    quantity: string;
    resourceKey: string;
    seriesId: string;
    source: ModuleId;
    tableId: string;
  };
  "charts:range-selected": {
    chartId: string;
    range: { fromValue: number; toValue: number } | null;
    source: ModuleId;
    tableId: string;
    xAxisId: string;
  };
  "viewport:mesh-size-bin-hovered": {
    highlight: MeshSizeHistogramHighlight | null;
    source: ModuleId;
  };
}
