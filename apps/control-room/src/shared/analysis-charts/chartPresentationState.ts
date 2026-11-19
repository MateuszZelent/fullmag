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

/** Header status overrides derived from a chart presentation state. */
export interface ChartPresentationStatusDisplay {
  detail?: string;
  isAlert?: boolean;
  primary: string;
  requestedRevision?: ResourceRevision | null;
  revision?: ResourceRevision | null;
}

/**
 * Maps a presentation state to the chart header status pill.
 *
 * A background refresh that retains the visible payload is not a user-facing
 * state change: the pill stays "Live" at the visible revision so it does not
 * toggle on every fetch. Loading is only surfaced when no payload is visible
 * (`initial-loading`).
 */
export function chartPresentationStatusDisplay(
  presentation: ChartDataPresentationState,
): ChartPresentationStatusDisplay {
  switch (presentation.kind) {
    case "ready":
      return { primary: "Live", revision: presentation.revision };
    case "refreshing":
      return { primary: "Live", revision: presentation.visibleRevision };
    case "paused":
      return {
        primary: "Paused",
        requestedRevision: presentation.latestKnownRevision,
        revision: presentation.visibleRevision,
      };
    case "stale":
      return {
        detail: presentation.error.message,
        isAlert: true,
        primary: "Refresh failed",
        revision: presentation.visibleRevision,
      };
    case "error":
      return { detail: presentation.error.message, isAlert: true, primary: "Error" };
    case "unsupported":
      return { detail: presentation.reason, primary: "Unavailable" };
    case "empty":
      return { primary: "No table data", revision: presentation.revision };
    case "initial-loading":
      return { primary: "Loading…" };
  }
}
