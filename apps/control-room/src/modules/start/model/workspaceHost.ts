import { tauriInvoke } from "@/kernel/persistence/ProjectDocumentController";

import {
  WorkspaceHostError,
  parseWorkspaceDialogResponse,
  parseWorkspaceHistory,
  parseWorkspaceItemResponse,
  parseWorkspaceList,
  parseWorkspaceScriptText,
  type WorkspaceEvent,
  type WorkspaceItem,
  type WorkspaceKind,
  type WorkspaceList,
  type WorkspaceScriptText,
} from "./workspaceItems";

/**
 * Bridge to the desktop host's workspace database. Projects keep using the
 * recent-index adapter; this one serves scripts (and carries the kind filter
 * so a later step can serve projects too). Every function either resolves to a
 * validated value or rejects with a `WorkspaceHostError`; nothing here throws
 * a raw host string into the UI. The browser build has no host, which is the
 * `unavailable` error, not a fault.
 */

export type WorkspaceSort = "last_used" | "name" | "modified" | "use_count";

export interface WorkspaceQuery {
  readonly kind: "all" | WorkspaceKind;
  readonly sort: WorkspaceSort;
  readonly search?: string;
  readonly limit?: number;
  readonly includeMissing?: boolean;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A host that predates the commands rejects with "Command <name> not found".
 * A bare "not found" is not enough: "script file not found" is a real answer
 * of an existing command and must reach the person as such.
 */
export function isMissingCommand(error: unknown): boolean {
  return /command\s+\S+\s+not found|unknown command|not allowed/i.test(describe(error));
}

/** True when a desktop host is present at all (not whether it has the commands). */
export function workspaceHostAvailable(): boolean {
  return tauriInvoke() !== null;
}

async function call(command: string, args?: Record<string, unknown>): Promise<unknown> {
  const invoke = tauriInvoke();
  if (!invoke) {
    throw new WorkspaceHostError("unavailable", "The workspace database needs the desktop app.");
  }
  try {
    return await invoke<unknown>(command, args);
  } catch (error) {
    if (error instanceof WorkspaceHostError) throw error;
    if (isMissingCommand(error)) {
      throw new WorkspaceHostError(
        "command_missing",
        "This desktop build does not provide the workspace database yet.",
      );
    }
    throw new WorkspaceHostError("host_error", describe(error));
  }
}

export async function listWorkspace(query: WorkspaceQuery): Promise<WorkspaceList> {
  const wire: Record<string, unknown> = { kind: query.kind, sort: query.sort };
  if (query.search) wire.search = query.search;
  if (query.limit !== undefined) wire.limit = query.limit;
  if (query.includeMissing !== undefined) wire.include_missing = query.includeMissing;
  return parseWorkspaceList(await call("workspace_list", { query: wire }));
}

export async function pinWorkspaceItem(id: number, pinned: boolean): Promise<void> {
  await call("workspace_pin", { id, pinned });
}

export async function forgetWorkspaceItem(id: number): Promise<void> {
  await call("workspace_forget", { id });
}

export async function workspaceHistory(
  id: number,
  limit?: number,
): Promise<readonly WorkspaceEvent[]> {
  const args: Record<string, unknown> = { id };
  if (limit !== undefined) args.limit = limit;
  return parseWorkspaceHistory(await call("workspace_history", args));
}

/** The native `.py` picker; resolves to null when the person cancels. */
export async function openScriptDialog(): Promise<WorkspaceItem | null> {
  return parseWorkspaceDialogResponse(await call("workspace_open_script_dialog"));
}

/** Records an open of a known script and returns the updated item. */
export async function openScript(id: number): Promise<WorkspaceItem> {
  return parseWorkspaceItemResponse(await call("workspace_open_script", { id }));
}

/**
 * Saves a script as a new file through the native Save dialog. The host picks
 * the folder, owns the path and refuses to replace a file the dialog did not
 * confirm; the renderer sends text and origin only. Resolves to null when the
 * person cancels the dialog.
 */
export async function saveNewScript(request: {
  readonly suggestedName: string;
  readonly text: string;
  readonly origin: "template" | "mx3";
  readonly originId: string;
}): Promise<WorkspaceItem | null> {
  return parseWorkspaceDialogResponse(
    await call("script_save_new", {
      request: {
        suggested_name: request.suggestedName,
        text: request.text,
        origin: request.origin,
        origin_id: request.originId,
      },
    }),
  );
}

export async function revealWorkspaceItem(id: number): Promise<void> {
  await call("workspace_reveal", { id });
}

export async function readScriptText(id: number): Promise<WorkspaceScriptText> {
  return parseWorkspaceScriptText(await call("workspace_read_script_text", { id }));
}
