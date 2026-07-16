import type {
  Viewport3DBuildJobKey,
  Viewport3DBuildLane,
} from "../viewport3dBuildEngineTypes";

export interface Viewport3DGpuUploadPolicy {
  readonly maxBytesPerSlice: number;
  readonly maxFrameBudgetMs: number;
  readonly maxItemsPerSlice: number;
  readonly targetFrameBudgetMs: number;
}

export interface Viewport3DGpuUploadChunk {
  readonly estimatedBytes: number;
  readonly itemCount: number;
  readonly rollback?: () => void;
  readonly upload: () => void;
}

export type Viewport3DGpuUploadStatus = "aborted" | "failed" | "ready";

export interface Viewport3DGpuUploadTicketInput {
  readonly chunks: readonly Viewport3DGpuUploadChunk[];
  readonly estimatedBytes: number;
  readonly key: Viewport3DBuildJobKey;
  readonly lane: Viewport3DBuildLane;
  readonly onVisible: () => void;
  readonly signal?: AbortSignal;
  readonly targetRevision: string | null;
}

export interface Viewport3DGpuUploadDiagnosticRecord {
  readonly aborted: boolean;
  readonly budgetExceeded: boolean;
  readonly completedAtMs: number;
  readonly error: string | null;
  readonly key: Viewport3DBuildJobKey;
  readonly kind: "viewport-3d-gpu-upload";
  readonly lane: Viewport3DBuildLane;
  readonly mainUploadMs: number;
  readonly maxChunkMs: number;
  readonly maxFrameUploadMs: number;
  readonly queuedAtMs: number;
  readonly targetRevision: string | null;
  readonly status: Viewport3DGpuUploadStatus;
  readonly totalWallMs: number;
  readonly uploadBytes: number;
  readonly uploadChunks: number;
  readonly uploadFrames: number;
}

export interface Viewport3DGpuUploadManager {
  readonly abort: (key: Viewport3DBuildJobKey) => boolean;
  readonly dispose: () => void;
  readonly enqueue: (ticket: Viewport3DGpuUploadTicketInput) => void;
}
