import type { ApiItemDetailAnswer, ApiWorkspaceItem, ResultDetail } from "../model/workspaceApiTypes";
import { chipList } from "./KeyValueGroup.presentation";
import { kvRow, kvRowOrUnavailable, type KvRow } from "./KeyValueGroup.model";
import { formatBytes, formatOpened } from "../model/recentIndex";
import { framesSummaryLine } from "../model/framesModel";
import { RESULTS_DOWNLOAD_FOLDER_MISSING, RESULTS_DOWNLOAD_NO_BACKEND } from "../model/downloadUrl";

export const RESULTS_VIEWER_NEEDS_SOURCE =
  "The results viewer opens the project that wrote this folder, and none is listed for it.";

export const RESULTS_VIEWER_SOURCE_IS_SCRIPT =
  "This folder was written by a script. The results viewer opens a project; run the script from its details to create one.";

export interface ViewerRoute {
  /** The project whose Results module shows the saved runs; null when there is none. */
  readonly project: ApiWorkspaceItem | null;
  /** Why "Open results viewer" is disabled; null when it can run. */
  readonly reason: string | null;
}

/** The legacy project route used when standalone saved playback is unavailable. */
export function viewerRoute(
  item: Pick<ApiWorkspaceItem, "status">,
  answer: ApiItemDetailAnswer | undefined,
): ViewerRoute {
  if (item.status === "missing") return { project: null, reason: "The folder is missing." };
  const source = answer?.linkedSource;
  if (source?.kind === "project") {
    return source.status === "missing"
      ? { project: null, reason: "The source project is missing." }
      : { project: source, reason: null };
  }
  return {
    project: null,
    reason: source?.kind === "script" ? RESULTS_VIEWER_SOURCE_IS_SCRIPT : RESULTS_VIEWER_NEEDS_SOURCE,
  };
}

/** Why "Download as zip" is off for this folder; null when it can run. */
export function downloadReason(
  item: Pick<ApiWorkspaceItem, "status">,
  archiveUrl: ((id: string) => string) | undefined,
): string | null {
  if (item.status === "missing") return RESULTS_DOWNLOAD_FOLDER_MISSING;
  return archiveUrl ? null : RESULTS_DOWNLOAD_NO_BACKEND;
}

/** What the preview image is, or why there is none; a result is never rendered as an image here. */
export function previewNote(item: ApiWorkspaceItem): string {
  if (!item.hasThumbnail) {
    return "none: the folder holds no image and its source project has no stored preview";
  }
  return item.thumbnailOrigin === "source_project"
    ? "stored preview of the source project, not a render of this result"
    : "stored preview";
}

export function resultFacts(item: ApiWorkspaceItem, result: ResultDetail | undefined): KvRow[][] {
  const total = result?.totalBytes ?? item.sizeBytes;
  const run: KvRow[] = result
    ? [
        ...kvRowOrUnavailable("Run", result.runId),
        ...kvRowOrUnavailable("Status", result.status),
        ...kvRow("Started", result.startedAt ? formatOpened(result.startedAt) : undefined),
        ...kvRow("Finished", result.finishedAt ? formatOpened(result.finishedAt) : undefined),
        ...kvRowOrUnavailable(
          "Format",
          result.format
            ? `${result.format}${result.formatVersion ? ` v${result.formatVersion}` : ""}`
            : undefined,
        ),
      ]
    : [];
  const data: KvRow[] = [
    ...(result ? kvRowOrUnavailable("Grid", result.grid) : []),
    ...(result
      ? kvRowOrUnavailable("Frames", result.frames === undefined ? undefined : result.frames.toLocaleString("en-US"))
      : []),
    ...(result?.framesIndex ? kvRow("Frame index", framesSummaryLine(result.framesIndex)) : []),
    ...kvRowOrUnavailable("Size", total === undefined ? undefined : formatBytes(total)),
    ...(result
      ? kvRowOrUnavailable(
          "Quantities",
          result.quantities.length > 0 ? chipList(result.quantities) : undefined,
        )
      : []),
  ];
  const where: KvRow[] = [
    ...kvRow("Preview", previewNote(item)),
    ...kvRow("Modified", item.modifiedAt ? formatOpened(item.modifiedAt) : undefined),
    ...kvRow("First seen", item.firstSeenAt ? formatOpened(item.firstSeenAt) : undefined),
  ];
  return [run, data, where];
}
