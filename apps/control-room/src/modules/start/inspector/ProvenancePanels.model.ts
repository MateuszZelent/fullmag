import { type ApiWorkspaceItem } from "../model/workspaceApiTypes";
import { RESULTS_DOWNLOAD_FOLDER_MISSING, RESULTS_DOWNLOAD_NO_BACKEND, RESULTS_DOWNLOAD_NO_FOLDER } from "../model/downloadUrl";

export interface RunsDownload {
  /** The zip of the newest linked result folder; null with the reason it cannot be offered. */
  readonly href: string | null;
  readonly reason: string | null;
}

/**
 * The download of a project's Runs tab is the newest linked result folder as a
 * zip (`GET /v2/workspace/items/{id}/archive`); linked folders arrive newest
 * first. A folder that is missing is skipped, not offered.
 */
export function resultsDownload(
  linkedResults: readonly ApiWorkspaceItem[],
  archiveUrl: ((id: string) => string) | undefined,
): RunsDownload {
  if (!archiveUrl) return { href: null, reason: RESULTS_DOWNLOAD_NO_BACKEND };
  if (linkedResults.length === 0) return { href: null, reason: RESULTS_DOWNLOAD_NO_FOLDER };
  const folder = linkedResults.find((item) => item.status !== "missing");
  if (!folder) return { href: null, reason: RESULTS_DOWNLOAD_FOLDER_MISSING };
  return { href: archiveUrl(folder.id), reason: null };
}
