export type LiveChartsCommandAction =
  | { kind: "fit" }
  | { format: "csv" | "tsv" | "png"; kind: "export" };

interface PendingRequest {
  action: LiveChartsCommandAction;
  resolve: (result: "completed" | "failed") => void;
}

class LiveChartsCommandRequests {
  private listeners = new Set<() => void>();
  private pending: PendingRequest | null = null;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.pending?.action ?? null;

  request(action: LiveChartsCommandAction): Promise<"completed" | "failed"> {
    if (this.listeners.size === 0 || this.pending) return Promise.resolve("failed");
    return new Promise((resolve) => {
      this.pending = { action, resolve };
      this.listeners.forEach((listener) => listener());
    });
  }

  complete(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.resolve("completed");
    this.listeners.forEach((listener) => listener());
  }
}

export const liveChartsCommandRequests = new LiveChartsCommandRequests();
