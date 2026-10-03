"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  forgetRecentProject,
  pinRecentProject,
  readRecentIndex,
  rebuildRecentIndex,
} from "./recentIndexHost";
import type { RecentIndexState } from "./types";

export interface RecentIndexController {
  readonly state: RecentIndexState;
  /** True while a rebuild is scanning; the previous list stays on screen. */
  readonly rebuilding: boolean;
  /** Result of the last action, for an aria-live region. */
  readonly announcement: string;
  /** Re-reads the index the host already has; cheap, unlike a rebuild. */
  readonly refresh: () => Promise<void>;
  readonly rebuild: () => Promise<void>;
  readonly pin: (projectId: string, pinned: boolean) => Promise<void>;
  readonly forget: (projectId: string) => Promise<void>;
}

/**
 * Loads the host's recent index. Failures never throw into the screen; they
 * become `error` or `unavailable` states, and a failed mutation keeps the list
 * that was already showing.
 */
export function useRecentIndex(): RecentIndexController {
  const [state, setState] = useState<RecentIndexState>({ kind: "loading" });
  const [rebuilding, setRebuilding] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void readRecentIndex().then((next) => {
      if (alive.current) setState(next);
    });
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const next = await readRecentIndex();
    if (alive.current) setState(next);
  }, []);

  const rebuild = useCallback(async () => {
    setRebuilding(true);
    setAnnouncement("Rebuilding the project index.");
    const next = await rebuildRecentIndex();
    if (!alive.current) return;
    setState(next);
    setRebuilding(false);
    setAnnouncement(
      next.kind === "ready"
        ? `Index rebuilt: ${next.index.entries.length} projects.`
        : next.kind === "error"
          ? `Index rebuild failed: ${next.message}`
          : "Index rebuilt.",
    );
  }, []);

  const mutate = useCallback(async (run: () => Promise<RecentIndexState>, failure: string) => {
    const next = await run();
    if (!alive.current) return;
    if (next.kind === "ready" || next.kind === "empty") setState(next);
    else setAnnouncement(next.kind === "error" ? `${failure}: ${next.message}` : failure);
  }, []);

  const pin = useCallback(
    (projectId: string, pinned: boolean) =>
      mutate(() => pinRecentProject(projectId, pinned), "Could not change the pin"),
    [mutate],
  );

  const forget = useCallback(
    (projectId: string) =>
      mutate(() => forgetRecentProject(projectId), "Could not remove the project from recent"),
    [mutate],
  );

  return { state, rebuilding, announcement, refresh, rebuild, pin, forget };
}
