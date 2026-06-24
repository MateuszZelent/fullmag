import type { Viewport3DGpuUploadDiagnosticRecord } from "./viewport3dGpuUploadTypes";

type Viewport3DGpuUploadDiagnosticListener = (
  record: Viewport3DGpuUploadDiagnosticRecord,
) => void;

const listeners = new Set<Viewport3DGpuUploadDiagnosticListener>();

export function recordViewport3DGpuUploadDiagnostic(
  record: Viewport3DGpuUploadDiagnosticRecord,
): void {
  for (const listener of listeners) {
    listener(record);
  }
}

export function subscribeViewport3DGpuUploadDiagnostics(
  listener: Viewport3DGpuUploadDiagnosticListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
