export type VisualizationDebugDisposition =
  | "ready"
  | "degraded"
  | "blocked"
  | "unknown";

export type VisualizationDebugEvidenceSource =
  | "backend-meta"
  | "cache"
  | "decoded-payload"
  | "render-derived"
  | "transport"
  | "ui-derived"
  | "webgl-shared";

export interface VisualizationDebugIssue {
  code: string;
  evidence: readonly string[];
  message: string;
  severity: "error" | "warning" | "info";
  source: VisualizationDebugEvidenceSource;
}

export interface VisualizationDebugSample {
  componentValues: readonly (number | null)[];
  magnitude: number | null;
  nodeIndex: number | null;
  pointIndex: number;
}

export type VisualizationDebugFieldResourceStatus =
  | "error"
  | "loading"
  | "pending"
  | "ready"
  | "stale"
  | "unavailable";

export interface VisualizationDebugFieldResourceState {
  dataAvailable: boolean;
  lastValidDataAvailable: boolean;
  reasonCode: string | null;
  revision: string | null;
  status: VisualizationDebugFieldResourceStatus;
}

export interface VisualizationDebugNumericStats {
  finiteCount: number;
  max: number | null;
  mean: number | null;
  min: number | null;
  nonFiniteCount: number;
  p01: number | null;
  p99: number | null;
  source: VisualizationDebugEvidenceSource;
  zeroCount: number;
}

export interface VisualizationDebugMemoryRow {
  byteLength: number | null;
  id: string;
  label: string;
  ownership: "owned" | "referenced" | "shared" | "estimated";
  source: VisualizationDebugEvidenceSource;
}

export interface VisualizationDebugCarrierSnapshot {
  cache: {
    byteLength: number | null;
    dataIdentityMatches?: boolean | null;
    entryState: "missing" | "inflight" | "ready";
    etag: string | null;
    fieldCacheByteLength: number;
    fieldCacheEntryCount: number;
    fieldCacheMaxBytes: number;
    retainCount: number;
  };
  carrierId: string;
  carrierRole: string;
  fieldResourceState?: VisualizationDebugFieldResourceState;
  geometryMaskDescription?: string | null;
  memory: readonly VisualizationDebugMemoryRow[];
  payload: {
    component: string | null;
    dtype: "float64";
    formatVersion: number | null;
    grid: readonly [number, number, number];
    indexing: string;
    nComp: number;
    nodeIndexCount: number | null;
    pointCount: number;
    quantityId: string;
    scopeId: string | null;
    scopeKind: string | null;
    valueCount: number;
  } | null;
  render: {
    adoption: {
      frameCommitId: string | null;
      surface: {
        adoptedAtMs: number | null;
        adoptedFieldBufferId: string | null;
        adoptedResourceKey: string | null;
        adoptedScalarBufferKey: string | null;
        adoptionSequence: number | null;
      };
      vector: {
        adoptedAtMs: number | null;
        adoptedFieldBufferId: string | null;
        adoptedResourceKey: string | null;
        adoptedVectorBuildKey: string | null;
        adoptedVectorItemCount: number | null;
        adoptionSequence: number | null;
      };
    };
    fieldBufferState: string;
    requestedFieldBufferId: string | null;
    requestedPasses: readonly string[];
    surface: {
      bufferKey: string | null;
      colorMode: string | null;
      degradation: string | null;
      projectionMode: string | null;
      scalarByteLength: number | null;
    };
    vectors: {
      buildKey: string | null;
      degradation: string | null;
      segmentByteLength: number | null;
      segmentCount: number | null;
    };
  };
  request: {
    plannerRequestId: string | null;
    resourceKey: string | null;
  };
  revisions: {
    domainGenerationId: string | null;
    fieldBufferRevision?: string | null;
    fieldRevision: string | null;
    meshTopologyHash: string | null;
    topologyRevision: string | null;
    visualizationRevision: string | null;
  };
  samples: readonly VisualizationDebugSample[];
  scanState: "idle" | "scanning" | "complete" | "cancelled" | "unavailable";
  statistics: readonly VisualizationDebugNumericStats[];
}

export interface VisualizationDebugSnapshot {
  capturedAtMs: number;
  carriers: readonly VisualizationDebugCarrierSnapshot[];
  disposition: VisualizationDebugDisposition;
  issues: readonly VisualizationDebugIssue[];
  memoryTotals?: {
    owned: number;
    referenced: number | null;
    shared: number | null;
  };
  ownedByteLength?: number;
  sharedMemory: readonly VisualizationDebugMemoryRow[];
  target: {
    carrierIds: readonly string[];
    id: string;
    kind: "airbox" | "object" | "region";
    label: string;
  };
  viewport: {
    airboxVectorsVisible?: boolean;
    airboxWireframeVisible?: boolean;
    contextLost: boolean | null;
    drawingBuffer: readonly [number, number] | null;
    frameCommittedAtMs: number;
    frameCommitId: string;
    viewportId: string;
  };
  version: 1;
}
