import type { ExplorerNodeStatus } from "./explorerTypes";

export function explorerStatusClassName(
  status: ExplorerNodeStatus | undefined,
): string | null {
  if (!status || status === "ready") return null;
  if (status === "completed" || status === "mesh-ready") {
    return "fm-explorer-node--done";
  }
  if (status === "queued" || status === "skipped" || status === "cancelled") {
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
