import type { RuntimeCommandPrecondition } from "../api/apiTypes";
import type { CommandContext } from "../commands/commandTypes";
import type { MeshBuildConfirmCommandId } from "../authoring/meshBuildConfirmation";
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
  | { kind: "object"; objectId: string }
  | {
      kind: "region";
      meshPartIds: readonly string[];
      objectId: string;
      regionId: string;
    };

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
  "workspace:new-problem-requested": {
    source: "menu" | "shortcut" | "workspace";
  };
  "explorer:texture-load-node-requested": {
    objectId: string;
    source: ModuleId;
  };
  "explorer:tab-requested": {
    source: ModuleId;
    tab: "diagnostics" | "jobs" | "model" | "resources" | "results";
  };
  "footer:tab-requested": {
    reason?: string;
    tab: "diagnostics" | "engine" | "logs" | "mesh" | "quick-chart" | "telemetry";
  };
  "diagnostics:recorder-open-requested": {
    source: string;
  };
  "mesh:build-confirm-requested": {
    commandId: MeshBuildConfirmCommandId;
    requestId?: string;
    input?: unknown;
    source: CommandContext["source"];
    sourceDetail?: string;
  };
  "mesh:build-confirm-resolved": {
    requestId: string;
    confirmed: boolean;
    precondition?: RuntimeCommandPrecondition;
  };
  "mesh:build-observation-requested": {
    commandId: string;
    requestId: string;
    objectId?: string;
    targetKind: "object_mesh" | "study_domain";
  };
  "mesh:build-observed": {
    commandId?: string;
    requestId?: string;
    status: "completed" | "failed" | "cancelled" | "pending";
    observation?: "waiting" | "disconnected" | "publication-unconfirmed";
    message?: string;
    meshRevision?: number;
  };
  "mesh:build-history-restore-requested": {
    buildId?: string;
    commandId?: string;
    entryId: string;
    meshTarget: string | null;
    snapshot: Record<string, unknown>;
  };
  "mesh:build-submitted": {
    requestId?: string;
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
    status: "completed" | "failed" | "cancelled" | "pending";
  };
  "resource:invalidated": {
    resourceKey: string;
    revision: string | number;
  };
  "resource:load-failed": {
    cause: string;
    errorName: string;
    resourceKey: string;
    revision: string | number | null;
    situation: string;
    source: "resource-hook";
    status: number | null;
  };
  "telemetry:scalar-sample": {
    revision: string | number;
    row: Record<string, number>;
    runId: string | null;
    sessionId: string;
    step: number;
    time: number;
  };
  "analysis-plots:export-requested": {
    chartId: string;
    format: "csv" | "tsv" | "png";
    source: ModuleId;
  };
  "analysis-plots:add-series-requested": {
    columnId: string;
    source: ModuleId;
    tableId: string;
  };
  "analysis-plots:series-selected": {
    chartId: string;
    quantity: string;
    resourceKey: string;
    seriesId: string;
    source: ModuleId;
    tableId: string;
  };
  "analysis-plots:range-selected": {
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
