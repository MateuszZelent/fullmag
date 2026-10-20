import type { ExplorerNodeStatus } from "./explorerTypes";

export function explorerStatusClassName(
  status: ExplorerNodeStatus | undefined,
): string | null {
  if (!status || status === "ready") return null;
  if (status === "completed" || status === "mesh-ready") {
    return "fm-explorer-node--done";
  }
  if (
    status === "queued" ||
    status === "skipped" ||
    status === "cancelled" ||
    status === "unavailable"
  ) {
    return "fm-explorer-node--muted";
  }
  if (status === "running" || status === "mesh-building") {
    return "fm-explorer-node--active";
  }
  if (
    status === "warning" ||
    status === "degraded" ||
    status === "mesh-stale" ||
    status === "primitive-only" ||
    status === "stale"
  ) {
    return "fm-explorer-node--warning";
  }
  if (
    status === "failed" ||
    status === "unsupported" ||
    status === "mesh-failed" ||
    status === "validation-blocked"
  ) {
    return "fm-explorer-node--failed";
  }
  return null;
}

const STATUS_LABELS: Readonly<Record<ExplorerNodeStatus, string>> = {
  ready: "Ready",
  "primitive-only": "Geometry only",
  "mesh-stale": "Mesh outdated",
  "mesh-building": "Meshing",
  "mesh-ready": "Mesh ready",
  "mesh-failed": "Meshing failed",
  "validation-blocked": "Blocked",
  stale: "Outdated",
  queued: "Queued",
  running: "Running",
  paused: "Paused",
  completed: "Completed",
  skipped: "Skipped",
  cancelled: "Cancelled",
  failed: "Failed",
  degraded: "Limited",
  warning: "Needs review",
  unavailable: "Unavailable",
  unsupported: "Unsupported",
};

export function explorerStatusLabel(status: ExplorerNodeStatus): string {
  return STATUS_LABELS[status];
}
