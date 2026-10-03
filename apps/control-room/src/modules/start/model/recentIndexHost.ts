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

/**
 * Read an archive the index points at. Returns the reason on failure so the
 * row can say why it did not open instead of doing nothing.
 */
export async function readProjectArchiveAtPath(
  path: string,
): Promise<
  { readonly ok: true; readonly source: ProjectArchiveSource } | { readonly ok: false; readonly reason: string }
> {
  const invoke = tauriInvoke();
  if (!invoke) return { ok: false, reason: "Opening by path needs the desktop app." };
  try {
    const opened = await invoke<HostOpenArchive>("open_project_archive_path", { path });
    return {
      ok: true,
      source: {
        bytes: base64ToBytes(opened.archive_base64),
        fileName: opened.file_name,
        hostPath: opened.path,
      },
    };
  } catch (error) {
    return { ok: false, reason: describe(error) };
  }
}
