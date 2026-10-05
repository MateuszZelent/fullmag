/**
 * Text and status mappings for result folders (.zarr), pure so the odd run
 * states a screenshot cannot show are testable.
 */

import type { ProjectStatus } from "./types";
import { metaString, type ApiWorkspaceItem } from "./workspaceApiTypes";

export interface ResultChip {
  readonly status: ProjectStatus;
  readonly label: string;
  readonly title: string;
}

/**
 * A folder's own state (missing, failed, ...) wins; otherwise the run status
 * the folder recorded. A folder that records none shows no chip rather than a
 * guessed "Ready".
 */
export function resultChip(item: Pick<ApiWorkspaceItem, "status" | "meta">, status?: string): ResultChip | null {
  if (item.status !== "ready") {
    return { status: item.status, label: "", title: "" };
  }
  const recorded = (status ?? metaString(item, "status"))?.toLowerCase();
  switch (recorded) {
    case undefined:
      return null;
    case "ok":
    case "completed":
    case "complete":
    case "succeeded":
    case "ready":
      return { status: "ready", label: "Complete", title: "The run completed" };
    case "running":
      return { status: "running", label: "Running", title: "The run is writing this folder" };
    case "failed":
    case "error":
      return { status: "failed", label: "Failed", title: "The run failed" };
    case "partial":
    case "incomplete":
    case "cancelled":
    case "canceled":
    case "stopped":
      return { status: "draft", label: "Incomplete", title: "The run ended before it finished" };
    default:
      return { status: "draft", label: recorded, title: `Run status: ${recorded}` };
  }
}

/** "stage-3" style ids stay as written; the kind, when known, follows in words. */
export function stageLabel(stage: { readonly id: string; readonly kind?: string }): string {
  return stage.kind ? `${stage.id} (${stage.kind})` : stage.id;
}

/** The run a folder came from, for its second row line: the source name when recorded. */
export function resultSourceName(item: Pick<ApiWorkspaceItem, "meta">): string | undefined {
  const named = metaString(item, "source_name");
  if (named) return named;
  const source = item.meta.source;
  if (typeof source === "string" && source !== "") return source;
  // The backend records the source as {kind, path, sha256}: name it by its file.
  if (source && typeof source === "object" && "path" in source && typeof source.path === "string") {
    return source.path.split(/[\/]/).filter(Boolean).pop();
  }
  return undefined;
}
