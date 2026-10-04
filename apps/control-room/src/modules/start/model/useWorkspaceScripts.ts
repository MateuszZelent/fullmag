"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  forgetWorkspaceItem,
  listWorkspace,
  openScript,
  openScriptDialog,
  pinWorkspaceItem,
  readScriptText,
  revealWorkspaceItem,
  workspaceHistory,
} from "./workspaceHost";
import {
  WorkspaceHostError,
  type WorkspaceEvent,
  type WorkspaceItem,
  type WorkspaceOutcome,
} from "./workspaceItems";

/**
 * Scripts as the start screen sees them. Mirrors `useRecentIndex`: the list
 * is derived state read from the host, a failure becomes a renderable state
 * and never an exception, and a failed action keeps the list that was showing.
 * The list is re-read on mount, when the window regains focus and after an
 * action; there is no timer.
 */
export type WorkspaceScriptsState =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly items: readonly WorkspaceItem[];
      readonly outcome: WorkspaceOutcome;
      readonly skipped: number;
    }
  /** No desktop host, or one that predates the workspace commands. */
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "error"; readonly message: string };

/** The most scripts one read asks for; sorting and search then run on the client. */
export const SCRIPT_LIST_LIMIT = 500;

/** Re-reads triggered by focus events closer together than this are merged. */
const FOCUS_REFRESH_MIN_MS = 750;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface WorkspaceScriptsController {
  readonly state: WorkspaceScriptsState;
  /** True when pins and forgets cannot be saved (database from a newer Fullmag). */
  readonly readOnly: boolean;
  /** Result of the last action, for an aria-live region. */
  readonly announcement: string;
  readonly refresh: () => Promise<void>;
  /** Each action resolves to a failure message, or null on success. */
  readonly pin: (id: number, pinned: boolean) => Promise<string | null>;
  readonly forget: (id: number) => Promise<string | null>;
  /** Records an open, then re-reads the list. */
  readonly open: (id: number) => Promise<string | null>;
  readonly reveal: (id: number) => Promise<string | null>;
  /** The native picker; the item is null when the person cancelled. */
  readonly pickAndOpen: () => Promise<{ readonly item: WorkspaceItem | null; readonly failure: string | null }>;
  readonly readText: (id: number) => Promise<{ readonly text: string } | { readonly failure: string }>;
}

function toState(error: unknown): WorkspaceScriptsState {
  if (error instanceof WorkspaceHostError) {
    if (error.code === "unavailable" || error.code === "command_missing") {
      return { kind: "unavailable", reason: error.message };
    }
  }
  return { kind: "error", message: describe(error) };
}

export function useWorkspaceScripts(): WorkspaceScriptsController {
  const [state, setState] = useState<WorkspaceScriptsState>({ kind: "loading" });
  const [announcement, setAnnouncement] = useState("");
  const alive = useRef(true);
  // Only the newest read may write the state: a slow older answer is dropped.
  const generation = useRef(0);
  const lastRead = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    lastRead.current = Date.now();
    let next: WorkspaceScriptsState;
    try {
      const list = await listWorkspace({
        kind: "script",
        sort: "last_used",
        limit: SCRIPT_LIST_LIMIT,
        includeMissing: true,
      });
      next = { kind: "ready", items: list.items, outcome: list.outcome, skipped: list.skipped };
    } catch (error) {
      next = toState(error);
    }
    if (!alive.current || mine !== generation.current) return;
    // A failed re-read keeps a list that is already on screen.
    setState((previous) => (next.kind === "error" && previous.kind === "ready" ? previous : next));
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const onFocus = () => {
      if (Date.now() - lastRead.current >= FOCUS_REFRESH_MIN_MS) void refresh();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") onFocus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive.current = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  /** Runs an action, re-reads the list, and turns a failure into a message. */
  const act = useCallback(
    async (run: () => Promise<unknown>, failure: string, done?: string): Promise<string | null> => {
      try {
        await run();
      } catch (error) {
        const message = `${failure}: ${describe(error)}`;
        if (alive.current) setAnnouncement(message);
        return message;
      }
      if (alive.current && done) setAnnouncement(done);
      await refresh();
      return null;
    },
    [refresh],
  );

  const pin = useCallback(
    (id: number, pinned: boolean) =>
      act(
        () => pinWorkspaceItem(id, pinned),
        "Could not change the pin",
        pinned ? "Script pinned." : "Script unpinned.",
      ),
    [act],
  );

  const forget = useCallback(
    (id: number) =>
      act(() => forgetWorkspaceItem(id), "Could not remove the script from recent", "Script removed from recent."),
    [act],
  );

  const open = useCallback(
    (id: number) => act(() => openScript(id), "Could not open the script", "Script opened."),
    [act],
  );

  const reveal = useCallback(
    async (id: number) => {
      try {
        await revealWorkspaceItem(id);
        return null;
      } catch (error) {
        return `Could not reveal the script: ${describe(error)}`;
      }
    },
    [],
  );

  const pickAndOpen = useCallback(async () => {
    try {
      const item = await openScriptDialog();
      if (item) {
        if (alive.current) setAnnouncement(`Opened ${item.name}.`);
        await refresh();
      }
      return { item, failure: null };
    } catch (error) {
      const failure = `Could not open a script: ${describe(error)}`;
      if (alive.current) setAnnouncement(failure);
      return { item: null, failure };
    }
  }, [refresh]);

  const readText = useCallback(async (id: number) => {
    try {
      return { text: (await readScriptText(id)).text };
    } catch (error) {
      return { failure: `Could not read the script: ${describe(error)}` };
    }
  }, []);

  return {
    state,
    readOnly: state.kind === "ready" && state.outcome.state === "read_only_newer_schema",
    announcement,
    refresh,
    pin,
    forget,
    open,
    reveal,
    pickAndOpen,
    readText,
  };
}

export type ScriptHistoryState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly events: readonly WorkspaceEvent[] }
  | { readonly kind: "unavailable" }
  | { readonly kind: "error"; readonly message: string };

/** How many events the inspector asks for; it shows a compact tail. */
export const HISTORY_LIMIT = 8;

/**
 * Recent events of one script. `refreshKey` changes when something recorded a
 * new event (the list was re-read and the item's last use moved), so the
 * history follows the list without a timer of its own.
 */
export function useScriptHistory(id: number, refreshKey: string): ScriptHistoryState {
  const [state, setState] = useState<ScriptHistoryState>({ kind: "loading" });

  useEffect(() => {
    let current = true;
    void workspaceHistory(id, HISTORY_LIMIT).then(
      (events) => {
        if (current) setState({ kind: "ready", events });
      },
      (error: unknown) => {
        if (!current) return;
        if (
          error instanceof WorkspaceHostError &&
          (error.code === "unavailable" || error.code === "command_missing")
        ) {
          setState({ kind: "unavailable" });
        } else {
          setState({ kind: "error", message: describe(error) });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [id, refreshKey]);

  return state;
}
