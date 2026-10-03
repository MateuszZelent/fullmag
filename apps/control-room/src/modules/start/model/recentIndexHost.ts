import {
  base64ToBytes,
  tauriInvoke,
  type ProjectArchiveSource,
} from "@/kernel/persistence/ProjectDocumentController";

import { parseRecentIndex } from "./recentIndex";
import type { RecentIndexState } from "./types";

/**
 * Bridge to the desktop host's recent-project index. The index is derived
 * state, so every failure here resolves to a state the screen can render; none
 * of these functions may reject into the UI. A browser build or a host without
 * the commands reports "unavailable", which is not an error.
 */

interface HostOpenArchive {
  readonly file_name: string;
  readonly archive_base64: string;
  readonly path: string;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A host that predates the command rejects with "command ... not found". */
function isMissingCommand(error: unknown): boolean {
  return /not found|unknown command|not allowed/i.test(describe(error));
}

async function call(command: string, args?: Record<string, unknown>): Promise<RecentIndexState> {
  const invoke = tauriInvoke();
  if (!invoke) return { kind: "unavailable" };
  try {
    return parseRecentIndex(await invoke<unknown>(command, args));
  } catch (error) {
    if (isMissingCommand(error)) return { kind: "unavailable" };
    return { kind: "error", message: describe(error) };
  }
}

export const readRecentIndex = (): Promise<RecentIndexState> => call("recent_index_read");

export const rebuildRecentIndex = (): Promise<RecentIndexState> => call("recent_index_rebuild");

export const pinRecentProject = (projectId: string, pinned: boolean): Promise<RecentIndexState> =>
  call("recent_index_pin", { projectId, pinned });

export const forgetRecentProject = (projectId: string): Promise<RecentIndexState> =>
  call("recent_index_forget", { projectId });

type ArchiveResult =
  | { readonly ok: true; readonly source: ProjectArchiveSource }
  | { readonly ok: false; readonly reason: string };

function toSource(opened: HostOpenArchive): ProjectArchiveSource {
  return {
    bytes: base64ToBytes(opened.archive_base64),
    fileName: opened.file_name,
    hostPath: opened.path,
  };
}

async function archiveCommand(
  command: string,
  args: Record<string, unknown>,
  withoutHost: string,
): Promise<ArchiveResult> {
  const invoke = tauriInvoke();
  if (!invoke) return { ok: false, reason: withoutHost };
  try {
    return { ok: true, source: toSource(await invoke<HostOpenArchive>(command, args)) };
  } catch (error) {
    return { ok: false, reason: describe(error) };
  }
}

/**
 * Read an archive the index points at. Returns the reason on failure so the
 * row can say why it did not open instead of doing nothing.
 */
export const readProjectArchiveAtPath = (path: string): Promise<ArchiveResult> =>
  archiveCommand("open_project_archive_path", { path }, "Opening by path needs the desktop app.");

/** Loads the checkpoint's project; the host continues the run once it is open. */
export const resumeRun = (projectId: string, runId: string): Promise<ArchiveResult> =>
  archiveCommand("resume_run", { projectId, runId }, "Resuming a run needs the desktop app.");

/** Deletes the checkpoint file and keeps the project. */
export async function discardCheckpoint(
  projectId: string,
  runId: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const invoke = tauriInvoke();
  if (!invoke) return { ok: false, reason: "Discarding a checkpoint needs the desktop app." };
  try {
    await invoke<unknown>("discard_checkpoint", { projectId, runId });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: describe(error) };
  }
}
