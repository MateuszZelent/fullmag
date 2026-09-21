import type { ChartRangePreference } from "@/kernel/workspace/liveChartPreferences";
import type { ChartExportRequestFormat } from "@/shared/analysis-charts/chartExport";

export type LiveChartsCommandAction =
  | { kind: "fit" }
  | { format: ChartExportRequestFormat; kind: "export"; requestId?: string }
  | { descriptorId?: string; kind: "set-live-mode"; liveMode: "following" | "paused" }
  | { descriptorId: string; kind: "set-preset" }
  | { descriptorId: string; kind: "set-selected-series"; selectedSeriesIds: string[] }
  | { descriptorId: string; kind: "set-range"; range: ChartRangePreference };

interface PendingRequest {
  action: LiveChartsCommandAction;
  resolve: (result: "completed" | "failed") => void;
}

class LiveChartsCommandRequests {
  private fitRequest = 0;
  private listeners = new Set<() => void>();
  private pending: PendingRequest | null = null;
  private exportRequestSequence = 0;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.failPending();
        this.fitRequest = 0;
      }
    };
  };

  getFitRequestSnapshot = () => this.fitRequest;

  getSnapshot = () => this.pending?.action ?? null;

  request(action: LiveChartsCommandAction): Promise<"completed" | "failed"> {
    if (this.listeners.size === 0 || this.pending) return Promise.resolve("failed");
    const normalizedAction = action.kind === "export"
      ? {
          ...action,
          requestId: action.requestId ?? `live-charts-export-${++this.exportRequestSequence}`,
        }
      : action;
    return new Promise((resolve) => {
      this.pending = { action: normalizedAction, resolve };
      if (normalizedAction.kind === "fit") this.fitRequest += 1;
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

  fail(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.resolve("failed");
    this.listeners.forEach((listener) => listener());
  }

  private failPending(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.resolve("failed");
  }
}

export const liveChartsCommandRequests = new LiveChartsCommandRequests();
