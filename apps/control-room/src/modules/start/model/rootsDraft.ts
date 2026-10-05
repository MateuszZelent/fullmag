/**
 * Edits of the indexed-locations list, as pure functions: the Settings section
 * keeps a draft of the roots and only the Save button sends it.
 */

import type { ApiItemKind, ApiWorkspaceRoot } from "./workspaceApiTypes";
import { isAbsolutePath } from "./workspaceSource";

export const ALL_KINDS: readonly ApiItemKind[] = ["project", "script", "result"];

export const KIND_LABEL: Readonly<Record<ApiItemKind, string>> = {
  project: "Projects",
  script: "Scripts",
  result: "Results",
};

/** The same folder written two ways must not become two roots. */
export const rootIdentity = (path: string): string => {
  const unified = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:/.test(unified) || unified.startsWith("//") ? unified.toLowerCase() : unified;
};

export type AddRootResult =
  | { readonly ok: true; readonly roots: readonly ApiWorkspaceRoot[] }
  | { readonly ok: false; readonly reason: string };

/** Adds a folder with every kind enabled and subfolders included. */
export function addRoot(roots: readonly ApiWorkspaceRoot[], rawPath: string): AddRootResult {
  const path = rawPath.trim();
  if (path === "") return { ok: false, reason: "Enter the absolute path of a folder." };
  if (!isAbsolutePath(path)) {
    return {
      ok: false,
      reason: "Enter an absolute path, for example C:\\data\\fullmag or /home/me/fullmag.",
    };
  }
  const identity = rootIdentity(path);
  if (roots.some((root) => rootIdentity(root.path) === identity)) {
    return { ok: false, reason: "That folder is already indexed." };
  }
  return {
    ok: true,
    roots: [...roots, { path, kinds: [...ALL_KINDS], recursive: true, enabled: true }],
  };
}

export const removeRoot = (roots: readonly ApiWorkspaceRoot[], path: string): ApiWorkspaceRoot[] =>
  roots.filter((root) => root.path !== path);

export function updateRoot(
  roots: readonly ApiWorkspaceRoot[],
  path: string,
  change: (root: ApiWorkspaceRoot) => ApiWorkspaceRoot,
): ApiWorkspaceRoot[] {
  return roots.map((root) => (root.path === path ? change(root) : root));
}

/** A root must keep at least one kind, or it would index nothing. */
export function toggleKind(root: ApiWorkspaceRoot, kind: ApiItemKind): ApiWorkspaceRoot {
  const has = root.kinds.includes(kind);
  if (has && root.kinds.length === 1) return root;
  return {
    ...root,
    kinds: has
      ? root.kinds.filter((k) => k !== kind)
      : ALL_KINDS.filter((k) => k === kind || root.kinds.includes(k)),
  };
}

export function sameRoots(a: readonly ApiWorkspaceRoot[], b: readonly ApiWorkspaceRoot[]): boolean {
  return (
    a.length === b.length &&
    a.every((root, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        root.path === other.path &&
        root.recursive === other.recursive &&
        root.enabled === other.enabled &&
        root.kinds.join() === other.kinds.join()
      );
    })
  );
}

/** One line for the scan report the Settings section shows after "Scan now". */
export function describeScan(report: {
  readonly scanned: number;
  readonly added: number;
  readonly updated: number;
  readonly missing: number;
  readonly skipped: number;
}): string {
  return `Scanned ${report.scanned.toLocaleString("en-US")}: ${report.added} added, ${report.updated} updated, ${report.missing} missing, ${report.skipped} skipped.`;
}
