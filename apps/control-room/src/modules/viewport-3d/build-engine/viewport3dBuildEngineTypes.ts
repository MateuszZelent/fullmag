export type Viewport3DBuildLane =
  | "binary-decode"
  | "bounds-hud"
  | "field-color"
  | "gpu-upload"
  | "mesh-quality"
  | "region-overlay"
  | "topology-index"
  | "vector-glyph";

export type Viewport3DBuildState =
  | "aborted"
  | "failed"
  | "queued"
  | "ready"
  | "running"
  | "stale"
  | "transferring"
  | "uploading";

export type Viewport3DBuildJobKey = string;

export interface Viewport3DBuildJobKeyParts {
  readonly algorithmVersion: number;
  readonly component: string | null;
  readonly domainId: string;
  readonly fieldRevision: string | null;
  readonly quantityId: string | null;
  readonly samplingRevision: string;
  readonly scopeId: string | null;
  readonly scopeKind: string | null;
  readonly sessionId: string;
  readonly styleRevision: string;
  readonly targetVisualizationRevision: string;
  readonly topologyRevision: string | null;
}

export interface Viewport3DBuildRequest {
  readonly groupKey?: string;
  readonly inputBytes: number;
  readonly itemCount: number;
  readonly key: Viewport3DBuildJobKey;
  readonly lane: Viewport3DBuildLane;
  readonly outputBytesEstimate: number;
  readonly revisionSummary: string;
}

export interface Viewport3DBuildRunnerContext {
  readonly recordFallback: (reason: string) => void;
  readonly signal: AbortSignal;
}

export type Viewport3DBuildRunner<TResult> = (
  request: Viewport3DBuildRequest,
  context: Viewport3DBuildRunnerContext,
) => Promise<TResult> | TResult;

export interface Viewport3DBuildScheduleOptions {
  readonly latestWins?: boolean;
  readonly onDiagnosticRecord?: (record: Viewport3DBuildDiagnosticRecord) => void;
  readonly onJobState?: (snapshot: Viewport3DBuildJobSnapshot) => void;
  readonly signal?: AbortSignal;
}

export interface Viewport3DBuildJobSnapshot {
  readonly itemCount: number;
  readonly key: Viewport3DBuildJobKey;
  readonly lane: Viewport3DBuildLane;
  readonly revisionSummary: string;
  readonly state: Viewport3DBuildState;
}

export interface Viewport3DBuildEngineSnapshot {
  readonly jobs: readonly Viewport3DBuildJobSnapshot[];
}

export interface Viewport3DBuildDiagnosticRecord {
  readonly abortedAtMs: number | null;
  readonly droppedBecauseObsolete: boolean;
  readonly fallbackReason: string | null;
  readonly finishedAtMs: number;
  readonly inputBytes: number;
  readonly itemCount: number;
  readonly key: Viewport3DBuildJobKey;
  readonly kind: "viewport-3d-build-job";
  readonly lane: Viewport3DBuildLane;
  readonly mainAdoptMs: number;
  readonly mainUploadMs: number;
  readonly outputBytes: number;
  readonly queuedAtMs: number;
  readonly queueWaitMs: number;
  readonly revisionSummary: string;
  readonly startedAtMs: number | null;
  readonly state: Viewport3DBuildState;
  readonly totalWallMs: number;
  readonly transferMs: number;
  readonly workerComputeMs: number;
}
