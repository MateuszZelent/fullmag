"use client";

import { useSyncExternalStore } from "react";

export interface ChartViewportHandoff {
  commandId: string;
  fieldRef: { fieldId: string; resourceKey: string };
  selection: {
    resourceKey: string;
    rowIds: readonly string[];
    semanticTarget?: string;
  };
}

export interface ChartViewportHandoffSnapshot {
  handoff: ChartViewportHandoff | null;
  message: string | null;
  status: "idle" | "pending" | "completed" | "cancelled" | "failed";
}

export class ChartViewportHandoffController {
  private active: { abort: AbortController; generation: number } | null = null;
  private generation = 0;
  private readonly listeners = new Set<() => void>();
  private snapshot: ChartViewportHandoffSnapshot = { handoff: null, message: null, status: "idle" };

  getSnapshot = (): ChartViewportHandoffSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  cancel(message = "Chart-to-viewport handoff cancelled."): void {
    if (!this.active) return;
    this.active.abort.abort();
    this.active = null;
    this.setSnapshot({ ...this.snapshot, message, status: "cancelled" });
  }

  async run<T>(
    handoff: ChartViewportHandoff,
    load: (signal: AbortSignal) => Promise<T>,
    adopt: (value: T) => void,
  ): Promise<ChartViewportHandoffSnapshot["status"]> {
    this.cancel("Superseded by a newer chart-to-viewport handoff.");
    const generation = ++this.generation;
    const abort = new AbortController();
    this.active = { abort, generation };
    this.setSnapshot({ handoff, message: null, status: "pending" });
    try {
      const value = await load(abort.signal);
      if (abort.signal.aborted || this.active?.generation !== generation) {
        return "cancelled";
      }
      adopt(value);
      this.active = null;
      this.setSnapshot({ handoff, message: "Field loaded in 3D.", status: "completed" });
      return "completed";
    } catch (error) {
      if (abort.signal.aborted || this.active?.generation !== generation) {
        return "cancelled";
      }
      this.active = null;
      this.setSnapshot({
        handoff,
        message: error instanceof Error ? error.message : "Chart-to-viewport handoff failed.",
        status: "failed",
      });
      return "failed";
    }
  }

  private setSnapshot(snapshot: ChartViewportHandoffSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

export function useChartViewportHandoff(
  controller: ChartViewportHandoffController,
): ChartViewportHandoffSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
