"use client";

import { useMemo } from "react";

import type { RecentIndexController } from "./useRecentIndex";
import type { WorkspaceItemsController } from "./useWorkspaceItems";
import type { WorkspaceScriptsController } from "./useWorkspaceScripts";
import { apiScriptToItem } from "./workspaceApiAdapters";
import {
  SCRIPT_NOT_IN_DESKTOP,
  desktopActionRefusal,
  desktopIdForPath,
  itemsOfKind,
  originOf,
  recentStateFromApi,
  scriptsStateFromApi,
  type WorkspaceOrigin,
  type WorkspaceResultsView,
  type WorkspaceScriptsView,
} from "./workspaceSource";
import type { RecentIndexState } from "./types";
import { workspaceHostAvailable } from "./workspaceHost";
import type { WorkspaceItemId } from "./workspaceItems";

export interface WorkspaceSource {
  readonly origin: WorkspaceOrigin;
  readonly recent: RecentIndexController;
  readonly scripts: WorkspaceScriptsView;
  readonly results: WorkspaceResultsView;
  /** The API controller, for the Settings section and the "Add file by path" form. */
  readonly workspace: WorkspaceItemsController;
  /** The API item id of a project/script row, for details and API actions. */
  readonly workspaceIdOfProject: (projectId: string) => string | null;
}

/** Wraps the desktop script controller so it speaks the id-agnostic view. */
function desktopScriptsView(desktop: WorkspaceScriptsController): WorkspaceScriptsView {
  const numeric = (id: WorkspaceItemId): number | null => (typeof id === "number" ? id : null);
  const refuse = <T,>(id: WorkspaceItemId, run: (n: number) => Promise<T>, otherwise: T): Promise<T> => {
    const n = numeric(id);
    return n === null ? Promise.resolve(otherwise) : run(n);
  };
  return {
    state: desktop.state,
    readOnly: desktop.readOnly,
    announcement: desktop.announcement,
    refresh: desktop.refresh,
    pin: (id, pinned) => refuse(id, (n) => desktop.pin(n, pinned), SCRIPT_NOT_IN_DESKTOP),
    forget: (id) => refuse(id, desktop.forget, SCRIPT_NOT_IN_DESKTOP),
    open: (id) => refuse(id, desktop.open, SCRIPT_NOT_IN_DESKTOP),
    reveal: (id) => refuse(id, desktop.reveal, SCRIPT_NOT_IN_DESKTOP),
    pickAndOpen: desktop.pickAndOpen,
    saveNew: desktop.saveNew,
    readText: (id) => refuse(id, desktop.readText, { failure: SCRIPT_NOT_IN_DESKTOP }),
    desktopIdOf: numeric,
  };
}

/**
 * Chooses between the HTTP workspace API and the desktop host and presents
 * one set of controllers to the list. With the API serving, pins, forgets and
 * scans go to the backend; actions only the desktop can perform (dialogs,
 * reading and running a script, revealing a file) stay on the host, reaching
 * its own record of a script by path.
 */
export function useWorkspaceSource(
  workspace: WorkspaceItemsController,
  desktopRecent: RecentIndexController,
  desktopScripts: WorkspaceScriptsController,
): WorkspaceSource {
  const origin = originOf(workspace.state);
  const apiList = workspace.state.kind === "ready" ? workspace.state.list : null;
  const desktopSession =
    desktopRecent.state.kind === "ready" ? desktopRecent.state.index.continue : undefined;
  const desktopScriptItems = desktopScripts.state.kind === "ready" ? desktopScripts.state.items : null;

  const { pin: apiPin, forget: apiForget, scan, refresh: apiRefresh, addByPath, thumbnailUrl } = workspace;

  const projectWorkspaceIds = useMemo(() => {
    const ids = new Map<string, string>();
    for (const item of apiList ? itemsOfKind(apiList.items, "project") : []) {
      ids.set(item.projectId ?? item.id, item.id);
    }
    return ids;
  }, [apiList]);

  const recent = useMemo<RecentIndexController>(() => {
    if (origin === "desktop") {
      // A backend failure with no desktop host to fall back on is shown, not hidden.
      if (workspace.state.kind === "error" && desktopRecent.state.kind === "unavailable") {
        return { ...desktopRecent, state: { kind: "error", message: workspace.state.message } };
      }
      return desktopRecent;
    }
    const state: RecentIndexState =
      origin === "pending" || !apiList
        ? { kind: "loading" }
        : recentStateFromApi(apiList.items, thumbnailUrl, desktopSession, new Date(0).toISOString());
    return {
      state,
      rebuilding: workspace.scanning,
      announcement: workspace.announcement,
      refresh: async () => apiRefresh(),
      rebuild: async () => {
        await scan();
      },
      pin: async (projectId, pinned) => {
        const id = projectWorkspaceIds.get(projectId);
        if (id) await apiPin(id, pinned);
      },
      forget: async (projectId) => {
        const id = projectWorkspaceIds.get(projectId);
        if (id) await apiForget(id);
      },
    };
  }, [
    origin,
    workspace.state,
    workspace.scanning,
    workspace.announcement,
    desktopRecent,
    apiList,
    thumbnailUrl,
    desktopSession,
    apiRefresh,
    scan,
    apiPin,
    apiForget,
    projectWorkspaceIds,
  ]);

  const scripts = useMemo<WorkspaceScriptsView>(() => {
    if (origin === "desktop") return desktopScriptsView(desktopScripts);
    const state =
      origin === "pending" || !apiList
        ? ({ kind: "loading" } as const)
        : scriptsStateFromApi(apiList.items, apiList.outcome, apiList.skipped);
    const desktopId = (id: WorkspaceItemId): number | null => {
      if (typeof id === "number") return id;
      const path = apiList?.items.find((item) => item.id === id)?.path;
      return path && desktopScriptItems ? desktopIdForPath(path, desktopScriptItems) : null;
    };
    const viaDesktop = async <T,>(
      id: WorkspaceItemId,
      run: (n: number) => Promise<T>,
      otherwise: T,
    ): Promise<T> => {
      const n = desktopId(id);
      return n === null ? otherwise : run(n);
    };
    const refusal = (): string => desktopActionRefusal(workspaceHostAvailable());
    // A script the desktop dialog or Save created is not in the API's list yet:
    // register its path with the backend so the row exists and can be selected.
    const registered = async (
      item: Awaited<ReturnType<WorkspaceScriptsView["pickAndOpen"]>>["item"],
    ) => {
      if (!item) return { item: null, failure: null };
      const added = await addByPath(item.path, "script");
      return "item" in added
        ? { item: apiScriptToItem(added.item), failure: null }
        : { item: null, failure: added.failure };
    };
    return {
      state,
      readOnly: state.kind === "ready" && state.outcome.state === "read_only_newer_schema",
      announcement: "",
      refresh: async () => apiRefresh(),
      pin: (id, pinned) => apiPin(String(id), pinned),
      forget: (id) => apiForget(String(id)),
      open: (id) =>
        viaDesktop(id, async (n) => {
          const failure = await desktopScripts.open(n);
          apiRefresh();
          return failure;
        }, refusal()),
      reveal: (id) => viaDesktop(id, desktopScripts.reveal, refusal()),
      pickAndOpen: async () => {
        const picked = await desktopScripts.pickAndOpen();
        if (picked.failure) return picked;
        return registered(picked.item);
      },
      saveNew: async (request) => {
        const outcome = await desktopScripts.saveNew(request);
        if (outcome.kind !== "saved") return outcome;
        const added = await registered(outcome.item);
        return added.item
          ? { kind: "saved", item: added.item }
          : { kind: "failed", message: added.failure ?? "The script was saved but not listed." };
      },
      readText: (id) => viaDesktop(id, desktopScripts.readText, { failure: refusal() }),
      desktopIdOf: desktopId,
    };
  }, [origin, apiList, desktopScripts, desktopScriptItems, apiRefresh, apiPin, apiForget, addByPath]);

  const results = useMemo<WorkspaceResultsView>(() => {
    const state =
      origin === "api" && apiList
        ? ({ kind: "ready", items: itemsOfKind(apiList.items, "result") } as const)
        : origin === "pending"
          ? ({ kind: "loading" } as const)
          : ({ kind: "unavailable" } as const);
    return { state, pin: apiPin, forget: apiForget };
  }, [origin, apiList, apiPin, apiForget]);

  const workspaceIdOfProject = useMemo(
    () => (projectId: string) => projectWorkspaceIds.get(projectId) ?? null,
    [projectWorkspaceIds],
  );

  return { origin, recent, scripts, results, workspace, workspaceIdOfProject };
}
