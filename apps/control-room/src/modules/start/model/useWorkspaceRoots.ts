"use client";

import { useCallback, useMemo } from "react";

import { useKernel } from "@/kernel/KernelContext";
import type { WorkspaceRootWire } from "@/kernel/api/apiTypes";
import { useResource } from "@/kernel/resources/useResource";

import {
  WORKSPACE_API_UNAVAILABLE,
  WORKSPACE_RESOURCE_PREFIX,
  WORKSPACE_ROOTS_RESOURCE_KEY,
  isRouteMissing,
  nextWorkspaceRevision,
} from "./useWorkspaceItems";
import { parseApiRoots, type ApiWorkspaceRoot } from "./workspaceApiTypes";

export type WorkspaceRootsState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly roots: readonly ApiWorkspaceRoot[] }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "error"; readonly message: string };

export interface WorkspaceRootsController {
  readonly state: WorkspaceRootsState;
  /** Replaces the roots; resolves to a failure message, or null on success. */
  readonly save: (roots: readonly ApiWorkspaceRoot[]) => Promise<string | null>;
}

/**
 * The folders the backend scans for projects, scripts and result folders.
 * Reads go through the resource layer; a save invalidates the `workspace:`
 * prefix so the list re-reads once the roots changed.
 */
export function useWorkspaceRoots(): WorkspaceRootsController {
  const { api, resources } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.workspace.roots({ signal }).then(parseApiRoots),
    [api],
  );
  const resource = useResource<readonly ApiWorkspaceRoot[]>({
    abortStaleInflight: true,
    load,
    resourceKey: WORKSPACE_ROOTS_RESOURCE_KEY,
    retryPolicy: null,
  });

  const state = useMemo<WorkspaceRootsState>(() => {
    if (resource.data) return { kind: "ready", roots: resource.data };
    if (resource.status === "error" && resource.error) {
      return isRouteMissing(resource.error)
        ? { kind: "unavailable", reason: WORKSPACE_API_UNAVAILABLE }
        : { kind: "error", message: resource.error.message };
    }
    return { kind: "loading" };
  }, [resource.data, resource.error, resource.status]);

  const save = useCallback(
    async (roots: readonly ApiWorkspaceRoot[]): Promise<string | null> => {
      const wire: WorkspaceRootWire[] = roots.map((root) => ({
        path: root.path,
        kinds: root.kinds,
        recursive: root.recursive,
        enabled: root.enabled,
      }));
      try {
        await api.workspace.saveRoots(wire);
      } catch (error) {
        return `Could not save the locations: ${error instanceof Error ? error.message : String(error)}`;
      }
      resources.invalidatePrefix(WORKSPACE_RESOURCE_PREFIX, nextWorkspaceRevision());
      return null;
    },
    [api, resources],
  );

  return { state, save };
}
