import type {
  ExplorerAvailability,
  ExplorerExecutionState,
  ExplorerNodeStateFacets,
  ExplorerNodeStatus,
  ExplorerResourceState,
} from "../explorerTypes";

export type ExplorerStatusTone = "active" | "done" | "failed" | "muted" | "ready" | "warning";

export interface ExplorerNodePresentationState {
  label: string;
  status: ExplorerNodeStatus;
  tone: ExplorerStatusTone;
}

const executionLabels: Record<ExplorerExecutionState, string> = {
  cancelled: "Cancelled",
  completed: "Completed",
  failed: "Failed",
  not_started: "Not started",
  paused: "Paused",
  queued: "Queued",
  running: "Running",
};

export function explorerNodePresentationState(
  facets: ExplorerNodeStateFacets,
): ExplorerNodePresentationState {
  if (facets.resourceState === "error") {
    return {
      label:
        facets.executionState === "not_started"
          ? "Resource error"
          : `Resource error · ${executionLabels[facets.executionState].toLowerCase()}`,
      status: "failed",
      tone: "failed",
    };
  }
  if (facets.availability === "unsupported") {
    return { label: "Unsupported", status: "unsupported", tone: "failed" };
  }
  if (facets.executionState === "failed") {
    return { label: "Failed", status: "failed", tone: "failed" };
  }
  if (facets.executionState === "running") {
    const suffix = [
      facets.resourceState === "stale" ? "stale data" : null,
      facets.availability === "partial" ? "partial" : null,
    ].filter((value): value is string => value !== null);
    return {
      label: ["Running", ...suffix].join(" · "),
      status: "running",
      tone: "active",
    };
  }
  if (facets.executionState === "queued" || facets.executionState === "paused") {
    return {
      label: executionLabels[facets.executionState],
      status: facets.executionState,
      tone: facets.executionState === "queued" ? "muted" : "warning",
    };
  }
  if (facets.executionState === "cancelled") {
    return { label: "Cancelled", status: "cancelled", tone: "muted" };
  }
  if (facets.availability === "unavailable") {
    return { label: "Unavailable", status: "unavailable", tone: "muted" };
  }
  if (facets.resourceState === "stale") {
    return { label: "Stale", status: "stale", tone: "warning" };
  }
  if (facets.resourceState === "loading") {
    return { label: "Loading", status: "queued", tone: "muted" };
  }
  if (facets.availability === "partial") {
    return { label: "Partial", status: "degraded", tone: "warning" };
  }
  if (facets.executionState === "completed") {
    return { label: "Completed", status: "completed", tone: "done" };
  }
  return { label: "Ready", status: "ready", tone: "ready" };
}

function facets(
  resourceState: ExplorerResourceState,
  executionState: ExplorerExecutionState,
  availability: ExplorerAvailability,
): ExplorerNodeStateFacets {
  return { availability, executionState, resourceState };
}

export function legacyStatusFacets(status: ExplorerNodeStatus): ExplorerNodeStateFacets {
  switch (status) {
    case "mesh-building":
      return facets("loading", "running", "partial");
    case "running":
      return facets("ready", "running", "available");
    case "queued":
      return facets("idle", "queued", "unavailable");
    case "paused":
      return facets("ready", "paused", "partial");
    case "completed":
    case "mesh-ready":
      return facets("ready", "completed", "available");
    case "cancelled":
    case "skipped":
      return facets("ready", "cancelled", "partial");
    case "failed":
    case "mesh-failed":
    case "validation-blocked":
      return facets("error", "failed", "unavailable");
    case "unsupported":
      return facets("ready", "not_started", "unsupported");
    case "unavailable":
      return facets("ready", "not_started", "unavailable");
    case "stale":
    case "mesh-stale":
      return facets("stale", "not_started", "available");
    case "degraded":
    case "primitive-only":
    case "warning":
      return facets("ready", "not_started", "partial");
    case "ready":
      return facets("ready", "not_started", "available");
  }
}
