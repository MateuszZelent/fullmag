import type { ResourceRevision } from "@/kernel/api/apiTypes";

export type ChartDataPresentationState =
  | { kind: "initial-loading" }
  | { kind: "ready"; revision: ResourceRevision }
  | {
      kind: "refreshing";
      visibleRevision: ResourceRevision;
      requestedRevision: ResourceRevision;
    }
  | {
      kind: "paused";
      visibleRevision: ResourceRevision;
      latestKnownRevision: ResourceRevision | null;
    }
  | { kind: "stale"; visibleRevision: ResourceRevision; error: Error }
  | { kind: "empty"; revision: ResourceRevision | null }
  | { kind: "unsupported"; reason: string }
  | { kind: "error"; error: Error };

export interface ChartResourceSnapshot<T> {
  /**
   * Empty is semantic payload metadata. It is intentionally not inferred from
   * object shape: a decoded, zero-row table is still a valid resource payload.
   */
  content?: "empty";
  status: "idle" | "loading" | "ready" | "stale" | "error" | "unsupported";
  data: T | null;
  visibleRevision: string | number | null;
  requestedRevision: string | number | null;
  error: Error | null;
  /** Required by projections that report the non-resource state `unsupported`. */
  unsupportedReason?: string | null;
}

export function deriveChartPresentationState<T>(
  snapshot: ChartResourceSnapshot<T>,
  options: { paused: boolean; latestKnownRevision: string | number | null },
): ChartDataPresentationState {
  if (snapshot.status === "unsupported") {
    return {
      kind: "unsupported",
      reason: snapshot.unsupportedReason ?? "Chart data is unsupported.",
    };
  }
  if (snapshot.content === "empty") {
    return { kind: "empty", revision: snapshot.visibleRevision ?? snapshot.requestedRevision };
  }
  if (snapshot.data === null) {
    if (snapshot.status === "error") {
      return { kind: "error", error: snapshot.error ?? new Error("Chart data unavailable") };
    }
    if (snapshot.status === "loading" || snapshot.status === "stale") {
      return { kind: "initial-loading" };
    }
    return { kind: "empty", revision: snapshot.visibleRevision ?? snapshot.requestedRevision };
  }

  const visibleRevision = snapshot.visibleRevision ?? snapshot.requestedRevision;
  if (visibleRevision === null) {
    return { kind: "empty", revision: null };
  }
  if (snapshot.status === "error") {
    return {
      kind: "stale",
      visibleRevision,
      error: snapshot.error ?? new Error("Chart refresh failed"),
    };
  }
  if (options.paused) {
    return {
      kind: "paused",
      latestKnownRevision: options.latestKnownRevision,
      visibleRevision,
    };
  }
  if (snapshot.status === "loading" || snapshot.status === "stale") {
    return {
      kind: "refreshing",
      requestedRevision: snapshot.requestedRevision ?? visibleRevision,
      visibleRevision,
    };
  }
  return { kind: "ready", revision: visibleRevision };
}
