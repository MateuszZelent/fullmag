"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

import {
  RUN_NEEDS_DESKTOP,
  reduceRun,
  type RunEvent,
  type RunPhase,
  type ScriptRunOptions,
} from "./scriptRun";
import {
  scriptOpenRecent,
  scriptPreflight,
  scriptRun,
  scriptRunStatus,
  scriptRunStop,
  scriptTrustForget,
  subscribeScriptRun,
} from "./scriptRunHost";
import { workspaceHostAvailable } from "./workspaceHost";
import { WorkspaceHostError } from "./workspaceItems";

/**
 * Run state per script, kept outside React so a run keeps its panel when the
 * person selects another script and comes back. The host owns the truth: this
 * store mirrors what the host reports and never decides on its own that a run
 * is over.
 */
const IDLE: RunPhase = { kind: "idle" };
const phases = new Map<number, RunPhase>();
const watchers = new Set<() => void>();
const unsubscribers = new Map<number, () => void>();
const finishedCallbacks = new Set<() => void>();

function emitChange(): void {
  for (const watcher of watchers) watcher();
}

function dispatch(itemId: number, event: RunEvent): RunPhase {
  const before = phases.get(itemId) ?? IDLE;
  const after = reduceRun(before, event);
  if (after !== before) {
    phases.set(itemId, after);
    emitChange();
    if (before.kind === "active" && after.kind === "finished") {
      unsubscribers.get(itemId)?.();
      unsubscribers.delete(itemId);
      for (const callback of finishedCallbacks) callback();
    }
  }
  return after;
}

const describe = (error: unknown): string =>
  error instanceof WorkspaceHostError && (error.code === "unavailable" || error.code === "command_missing")
    ? RUN_NEEDS_DESKTOP
    : error instanceof Error
      ? error.message
      : String(error);

/** Opens a ticket for the script and reads its static facts. Nothing runs. */
export async function prepareRun(itemId: number): Promise<void> {
  dispatch(itemId, { type: "prepare" });
  if ((phases.get(itemId) ?? IDLE).kind !== "preparing") return;
  try {
    const handle = await scriptOpenRecent(itemId);
    const preflight = await scriptPreflight(handle.ticket);
    dispatch(itemId, { type: "prepared", handle, preflight });
  } catch (error) {
    dispatch(itemId, { type: "error", message: describe(error) });
  }
}

/** Asks the host to run the prepared script; the host shows the native prompt. */
export async function startRun(itemId: number, options: ScriptRunOptions): Promise<void> {
  const phase = phases.get(itemId) ?? IDLE;
  if (phase.kind !== "ready") return;
  const ticket = phase.handle.ticket;
  dispatch(itemId, { type: "ask" });
  try {
    const result = await scriptRun(ticket, options);
    // Status events can arrive before this answer: hold them until it is known.
    const early: Parameters<typeof dispatch>[1][] = [];
    let release: (() => void) | null = null;
    if (result.status === "started") {
      release = subscribeScriptRun(
        result.runHandle,
        (status) => {
          if ((phases.get(itemId) ?? IDLE).kind === "active") dispatch(itemId, { type: "status", status });
          else early.push({ type: "status", status });
        },
        () => {},
      );
      unsubscribers.set(itemId, release);
    }
    dispatch(itemId, { type: "result", result });
    for (const event of early) dispatch(itemId, event);
    if (result.status === "started") {
      // One read closes the gap before the subscription was live.
      try {
        dispatch(itemId, { type: "status", status: await scriptRunStatus(result.runHandle) });
      } catch {
        // The event stream still reports; a failed read is not fatal.
      }
    }
  } catch (error) {
    dispatch(itemId, { type: "error", message: describe(error) });
  }
}

export async function stopRun(itemId: number): Promise<void> {
  const phase = phases.get(itemId) ?? IDLE;
  if (phase.kind !== "active") return;
  try {
    await scriptRunStop(phase.status.runHandle);
  } catch (error) {
    dispatch(itemId, { type: "error", message: describe(error) });
  }
}

export function dismissRun(itemId: number): void {
  dispatch(itemId, { type: "reset" });
}

/** Re-reads an active run, for the moments an event may have been missed. */
async function resyncRun(itemId: number): Promise<void> {
  const phase = phases.get(itemId) ?? IDLE;
  if (phase.kind !== "active") return;
  try {
    dispatch(itemId, { type: "status", status: await scriptRunStatus(phase.status.runHandle) });
  } catch {
    // A host that forgot the run cannot be asked again; the panel keeps its state.
  }
}

export interface ScriptRunController {
  readonly phase: RunPhase;
  /** False in the browser build and with a desktop host that predates the commands. */
  readonly hostAvailable: boolean;
  readonly prepare: () => Promise<void>;
  readonly run: (options: ScriptRunOptions) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly dismiss: () => void;
  /** Resolves to a failure message, or null. */
  readonly forgetTrust: () => Promise<string | null>;
}

const subscribe = (callback: () => void): (() => void) => {
  watchers.add(callback);
  return () => {
    watchers.delete(callback);
  };
};

/** The run controller of one script. `onFinished` fires when any run ends. */
export function useScriptRun(itemId: number, onFinished?: () => void): ScriptRunController {
  const phase = useSyncExternalStore(
    subscribe,
    () => phases.get(itemId) ?? IDLE,
    () => IDLE,
  );

  useEffect(() => {
    if (!onFinished) return undefined;
    finishedCallbacks.add(onFinished);
    return () => {
      finishedCallbacks.delete(onFinished);
    };
  }, [onFinished]);

  const active = phase.kind === "active";
  useEffect(() => {
    if (!active) return undefined;
    const onFocus = () => void resyncRun(itemId);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, itemId]);

  const prepare = useCallback(() => prepareRun(itemId), [itemId]);
  const run = useCallback((options: ScriptRunOptions) => startRun(itemId, options), [itemId]);
  const stop = useCallback(() => stopRun(itemId), [itemId]);
  const dismiss = useCallback(() => dismissRun(itemId), [itemId]);
  const forgetTrust = useCallback(async () => {
    try {
      await scriptTrustForget(itemId);
      return null;
    } catch (error) {
      return describe(error);
    }
  }, [itemId]);

  return { phase, hostAvailable: workspaceHostAvailable(), prepare, run, stop, dismiss, forgetTrust };
}

/** Test seam: forget every stored phase. */
export function resetScriptRunStore(): void {
  for (const release of unsubscribers.values()) release();
  unsubscribers.clear();
  phases.clear();
  emitChange();
}
