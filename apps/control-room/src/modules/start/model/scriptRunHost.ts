import { tauriInvoke } from "@/kernel/persistence/ProjectDocumentController";

import {
  parseScriptHandle,
  parseScriptPick,
  parseScriptPreflight,
  parseScriptRunResult,
  parseScriptRunStatus,
  runRequestWire,
  type ScriptHandle,
  type ScriptPreflight,
  type ScriptRunOptions,
  type ScriptRunResult,
  type ScriptRunStatus,
} from "./scriptRun";
import { isMissingCommand } from "./workspaceHost";
import { WorkspaceHostError } from "./workspaceItems";

/**
 * Bridge to the desktop host's script-run commands (08-script-open.md 6.1).
 * Nothing here takes a path: a script is a host-issued ticket or a workspace
 * item id, and the consent prompt is native to the host, so no argument can
 * answer it. The browser build has no host, which is the `unavailable` error.
 */

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function call(command: string, args?: Record<string, unknown>): Promise<unknown> {
  const invoke = tauriInvoke();
  if (!invoke) {
    throw new WorkspaceHostError("unavailable", "Running a script needs the desktop app.");
  }
  try {
    return await invoke<unknown>(command, args);
  } catch (error) {
    if (error instanceof WorkspaceHostError) throw error;
    if (isMissingCommand(error)) {
      throw new WorkspaceHostError(
        "command_missing",
        "This desktop build cannot run scripts from the start screen yet.",
      );
    }
    throw new WorkspaceHostError("host_error", describe(error));
  }
}

/** The native `.py` picker; resolves to null when the person cancels. */
export async function scriptPick(): Promise<ScriptHandle | null> {
  return parseScriptPick(await call("script_pick"));
}

/** A ticket for a script of the list. The host re-reads the stored path. */
export async function scriptOpenRecent(itemId: number): Promise<ScriptHandle> {
  return parseScriptHandle(await call("script_open_recent", { itemId }));
}

/** Static facts about the file. Nothing is executed. */
export async function scriptPreflight(ticket: string): Promise<ScriptPreflight> {
  return parseScriptPreflight(await call("script_preflight", { ticket }));
}

/**
 * Starts the run after the host-native consent prompt. Resolves to `declined`
 * when the person cancels it and to `refused` (with a code) when the host
 * refuses before spawning anything.
 */
export async function scriptRun(ticket: string, options: ScriptRunOptions): Promise<ScriptRunResult> {
  return parseScriptRunResult(await call("script_run", { request: runRequestWire(ticket, options) }));
}

export async function scriptRunStatus(runHandle: string): Promise<ScriptRunStatus> {
  return parseScriptRunStatus(await call("script_run_status", { runHandle }));
}

/** Graceful stop; the host ends the whole process tree after 10 seconds. */
export async function scriptRunStop(runHandle: string): Promise<void> {
  await call("script_run_stop", { runHandle });
}

/** Forget a remembered "do not ask again" decision for the item. */
export async function scriptTrustForget(itemId: number): Promise<void> {
  await call("script_trust_forget", { itemId });
}

type TauriListen = (
  event: string,
  handler: (message: { readonly payload: unknown }) => void,
) => Promise<() => void>;

function tauriListen(): TauriListen | null {
  if (typeof window === "undefined") return null;
  const tauri = (window as unknown as { __TAURI__?: { event?: { listen?: unknown } } }).__TAURI__;
  return typeof tauri?.event?.listen === "function" ? (tauri.event.listen as TauriListen) : null;
}

/**
 * Status changes of one run, pushed by the host as `script-run:<handle>`
 * events. Returns a function that stops listening. Without a host event bridge
 * it does nothing; the caller still reads `scriptRunStatus` when the window
 * regains focus.
 */
export function subscribeScriptRun(
  runHandle: string,
  onStatus: (status: ScriptRunStatus) => void,
  onInvalid: (error: unknown) => void,
): () => void {
  const listen = tauriListen();
  if (!listen) return () => {};
  let stopped = false;
  let unlisten: (() => void) | null = null;
  void listen(`script-run:${runHandle}`, (message) => {
    try {
      onStatus(parseScriptRunStatus(message.payload));
    } catch (error) {
      onInvalid(error);
    }
  }).then(
    (stop) => {
      if (stopped) stop();
      else unlisten = stop;
    },
    onInvalid,
  );
  return () => {
    stopped = true;
    unlisten?.();
  };
}
