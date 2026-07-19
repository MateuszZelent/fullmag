import type { RealtimeConnectionStatus } from "./RealtimeClient";

export interface RealtimeConnectionSnapshot {
  readonly disrupted: boolean;
  readonly status: RealtimeConnectionStatus;
}

type RealtimeConnectionListener = () => void;

const INITIAL_REALTIME_CONNECTION_SNAPSHOT: RealtimeConnectionSnapshot = {
  disrupted: false,
  status: "idle",
};

export class RealtimeConnectionController {
  private snapshot = INITIAL_REALTIME_CONNECTION_SNAPSHOT;
  private readonly listeners = new Set<RealtimeConnectionListener>();

  getSnapshot(): RealtimeConnectionSnapshot {
    return this.snapshot;
  }

  subscribe(listener: RealtimeConnectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(status: RealtimeConnectionStatus): void {
    const disrupted = resolveDisrupted(this.snapshot, status);
    if (
      this.snapshot.status === status &&
      this.snapshot.disrupted === disrupted
    ) {
      return;
    }

    this.snapshot = { disrupted, status };
    for (const listener of this.listeners) listener();
  }
}

function resolveDisrupted(
  current: RealtimeConnectionSnapshot,
  status: RealtimeConnectionStatus,
): boolean {
  if (status === "connected" || status === "idle") return false;
  if (status === "disconnected" || status === "error") return true;
  return current.disrupted;
}
