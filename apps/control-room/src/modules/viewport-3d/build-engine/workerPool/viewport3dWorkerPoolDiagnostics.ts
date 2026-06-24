import type { Viewport3DWorkerPoolSnapshot } from "./viewport3dWorkerPoolTypes";

export interface Viewport3DWorkerPoolDiagnosticRecord
  extends Viewport3DWorkerPoolSnapshot {
  readonly kind: "viewport-3d-worker-pool";
  readonly poolId: string;
}

export function createViewport3DWorkerPoolDiagnosticRecord(
  poolId: string,
  snapshot: Viewport3DWorkerPoolSnapshot,
): Viewport3DWorkerPoolDiagnosticRecord {
  return {
    ...snapshot,
    kind: "viewport-3d-worker-pool",
    poolId,
  };
}
