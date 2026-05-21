"use client";

import { useCallback } from "react";

import type { LiveStatusResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import { useResource, useResourceSelector } from "./useResource";
import type { ResourceResult } from "./resourceTypes";

export const SESSION_STATUS_RESOURCE_KEY = "session:status";

const SESSION_STATUS_REVISION_RESOURCE_KEYS: Array<
  keyof LiveStatusResource["resources"]
> = [
  "command_completion_revision",
  "commands_revision",
  "display_revision",
  "domain_generation_id",
  "mesh_build_revision",
  "mesh_revision",
  "scene_revision",
  "solver_profile_revision",
  "stages_revision",
  "visualization_state_revision",
  "workspace_revision",
];

export function resolveSessionStatusRevision(
  status: LiveStatusResource,
): number | null {
  const revisions = SESSION_STATUS_REVISION_RESOURCE_KEYS.map(
    (key) => status.resources[key],
  ).filter((revision): revision is number => typeof revision === "number");

  return revisions.length > 0 ? Math.max(...revisions) : null;
}

export function useSessionStatus() {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.sessions.current.status({ signal }),
    [api],
  );

  return useResource({
    load,
    resolveRevision: resolveSessionStatusRevision,
    resourceKey: SESSION_STATUS_RESOURCE_KEY,
  });
}

export function useSessionStatusSelector<TSelected>(
  selector: (status: ResourceResult<LiveStatusResource>) => TSelected,
  options: {
    enabled?: boolean;
    isEqual?: (previous: TSelected, next: TSelected) => boolean;
  } = {},
): TSelected {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.sessions.current.status({ signal }),
    [api],
  );

  return useResourceSelector({
    enabled: options.enabled,
    isEqual: options.isEqual,
    load,
    resolveRevision: resolveSessionStatusRevision,
    resourceKey: SESSION_STATUS_RESOURCE_KEY,
    selector,
  });
}
