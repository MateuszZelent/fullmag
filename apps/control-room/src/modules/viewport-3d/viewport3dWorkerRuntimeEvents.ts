type WorkerRuntimeListener = () => void;

const listeners = new Set<WorkerRuntimeListener>();

export function notifyViewport3DWorkerRuntimeChange(): void {
  for (const listener of listeners) listener();
}

export function subscribeViewport3DWorkerRuntimeChanges(
  listener: WorkerRuntimeListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const viewport3DWorkerRuntimeEvents = {
  subscribe: subscribeViewport3DWorkerRuntimeChanges,
};
