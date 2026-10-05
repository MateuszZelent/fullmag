/**
 * Which source serves the start screen's lists, as pure functions.
 *
 * The HTTP workspace API is preferred whenever the backend serves it, in the
 * browser and in the desktop build alike. A backend that predates the routes
 * (404) or cannot be read leaves the desktop host's own data in place, and
 * with neither the lists say what is missing instead of looking empty.
 */

import type { ScriptSaveOutcome, ScriptSaveRequest } from "./scriptOpen";
import type { ContinueSession, RecentIndex, RecentIndexState } from "./types";
import type { WorkspaceApiListState } from "./useWorkspaceItems";
import {
  apiProjectToEntry,
  apiScriptToItem,
} from "./workspaceApiAdapters";
import type { ApiWorkspaceItem } from "./workspaceApiTypes";
import type { WorkspaceItem, WorkspaceItemId, WorkspaceOutcome } from "./workspaceItems";

/**
 * - `api`: the backend answered; it is the source of truth for every list.
 * - `pending`: the first answer has not arrived; lists show their skeleton.
 * - `desktop`: the backend does not serve the database (or failed); the
 *   desktop host's data, if any, is what is shown.
 */
export type WorkspaceOrigin = "api" | "pending" | "desktop";

export function originOf(api: WorkspaceApiListState): WorkspaceOrigin {
  if (api.kind === "ready") return "api";
  if (api.kind === "loading") return "pending";
  return "desktop";
}

export type WorkspaceScriptsViewState =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly items: readonly WorkspaceItem[];
      readonly outcome: WorkspaceOutcome;
      readonly skipped: number;
    }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "error"; readonly message: string };

/** The script list and its actions, for either id type. */
export interface WorkspaceScriptsView {
  readonly state: WorkspaceScriptsViewState;
  readonly readOnly: boolean;
  readonly announcement: string;
  readonly refresh: () => Promise<void>;
  /** Each action resolves to a failure message, or null on success. */
  readonly pin: (id: WorkspaceItemId, pinned: boolean) => Promise<string | null>;
  readonly forget: (id: WorkspaceItemId) => Promise<string | null>;
  readonly open: (id: WorkspaceItemId) => Promise<string | null>;
  readonly reveal: (id: WorkspaceItemId) => Promise<string | null>;
  readonly pickAndOpen: () => Promise<{
    readonly item: WorkspaceItem | null;
    readonly failure: string | null;
  }>;
  readonly saveNew: (request: ScriptSaveRequest) => Promise<ScriptSaveOutcome>;
  readonly readText: (
    id: WorkspaceItemId,
  ) => Promise<{ readonly text: string } | { readonly failure: string }>;
  /** The id the desktop host knows the script by (needed to run it); null when it has none. */
  readonly desktopIdOf: (id: WorkspaceItemId) => number | null;
}

export type WorkspaceResultsState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly items: readonly ApiWorkspaceItem[] }
  /** No backend route (or no backend): the Results kind is not offered. */
  | { readonly kind: "unavailable" };

export interface WorkspaceResultsView {
  readonly state: WorkspaceResultsState;
  readonly pin: (id: string, pinned: boolean) => Promise<string | null>;
  readonly forget: (id: string) => Promise<string | null>;
  /** Builds a thumbnail URL; a result shows only its source project's stored preview. */
  readonly thumbnailUrl?: (id: string) => string;
}

export const itemsOfKind = (
  items: readonly ApiWorkspaceItem[],
  kind: ApiWorkspaceItem["kind"],
): ApiWorkspaceItem[] => items.filter((item) => item.kind === kind);

export function recentStateFromApi(
  items: readonly ApiWorkspaceItem[],
  thumbnailUrl: (id: string) => string,
  session: ContinueSession | undefined,
  generatedAt: string,
): RecentIndexState {
  const entries = itemsOfKind(items, "project").map((item) =>
    apiProjectToEntry(item, { thumbnailUrl, runningProjectId: session?.projectId }),
  );
  if (entries.length === 0) return { kind: "empty" };
  const index: RecentIndex = { formatVersion: 1, generatedAt, entries, continue: session };
  return { kind: "ready", index };
}

export function scriptsStateFromApi(
  items: readonly ApiWorkspaceItem[],
  outcome: WorkspaceOutcome,
  skipped: number,
): WorkspaceScriptsViewState {
  return { kind: "ready", items: itemsOfKind(items, "script").map(apiScriptToItem), outcome, skipped };
}

/* ── Matching an API script to the desktop host's own record ────────────── */

/** `\\?\C:\x` verbatim prefix removed; separators unified; Windows paths compared case-blind. */
export function comparablePath(path: string): string {
  const stripped = path.startsWith("\\\\?\\UNC\\")
    ? `\\\\${path.slice(8)}`
    : path.startsWith("\\\\?\\")
      ? path.slice(4)
      : path;
  const unified = stripped.replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(unified) || unified.startsWith("//") ? unified.toLowerCase() : unified;
}

export function desktopIdForPath(
  path: string,
  desktopItems: readonly WorkspaceItem[],
): number | null {
  const wanted = comparablePath(path);
  for (const item of desktopItems) {
    if (typeof item.id === "number" && comparablePath(item.path) === wanted) return item.id;
  }
  return null;
}

export const SCRIPT_NOT_IN_DESKTOP =
  "The desktop app has no record of this script. Use Open script… to add it, then try again.";

/** Opening, revealing, reading and running a file are done by the desktop app. */
export const NEEDS_DESKTOP = "Needs the desktop app.";

/** Why a desktop-only action on a script cannot run; the browser build has no desktop at all. */
export const desktopActionRefusal = (hostAvailable: boolean): string =>
  hostAvailable ? SCRIPT_NOT_IN_DESKTOP : NEEDS_DESKTOP;

/** An absolute POSIX, Windows drive or UNC path; the backend validates it again. */
export function isAbsolutePath(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]|\/)/.test(path.trim());
}

export const ADD_PATH_NOT_ABSOLUTE =
  "Enter an absolute path, for example C:\\data\\run.zarr or /home/me/model.fms.";

/**
 * Validates a typed path and hands it to the backend. Resolves to a message to
 * show (the path is not absolute, or the backend refused it), or null when it
 * was added. The backend validates again: this only spares it an obvious typo.
 */
export async function addPathOutcome(
  raw: string,
  add: (path: string) => Promise<string | null>,
): Promise<string | null> {
  const path = raw.trim();
  if (!isAbsolutePath(path)) return ADD_PATH_NOT_ABSOLUTE;
  return add(path);
}
