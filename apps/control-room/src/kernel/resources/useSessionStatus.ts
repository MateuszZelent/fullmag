"use client";

import { useCallback } from "react";

import type { LiveStatusResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import { statusRefreshIntervalMs } from "../realtime/communicationPolicy";

import { useResourceSelector } from "./useResource";
import type { ResourceResult } from "./resourceTypes";
import {
  selectSessionLifecycle,
  type SelectedSessionLifecycle,
} from "./sessionLifecycle";
import {
  sessionResourceIdentitiesEqual,
  sessionResourceIdentityFromStatus,
  type SessionResourceIdentity,
} from "./sessionResourceIdentity";

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
  "region_coefficients_revision",
  "region_initial_state_revision",
  "region_membership_revision",
  "region_topology_revision",
  "scene_revision",
  "simulation_preparation_revision",
  "solver_profile_revision",
  "stages_revision",
  "visualization_state_revision",
  "workspace_revision",
];

export function resolveSessionStatusRevision(
  status: LiveStatusResource,
): number | null {
  const revisions: number[] = [];
  for (const key of SESSION_STATUS_REVISION_RESOURCE_KEYS) {
    const revision = status.resources[key];
    if (typeof revision === "number") {
      revisions.push(revision);
    }
  }

  return revisions.length > 0 ? Math.max(...revisions) : null;
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
    minRefetchIntervalMs: statusRefreshIntervalMs(),
    resolveRevision: resolveSessionStatusRevision,
    resourceKey: SESSION_STATUS_RESOURCE_KEY,
    selector,
  });
}

export function useSessionResourceIdentity(): SessionResourceIdentity | null {
  return useSessionStatusSelector(
    (status) => sessionResourceIdentityFromStatus(status.data),
    { isEqual: sessionResourceIdentitiesEqual },
  );
}

export function useSessionLifecycle(): SelectedSessionLifecycle | null {
  return useSessionStatusSelector((status) =>
    status.data?.lifecycle ? selectSessionLifecycle(status.data.lifecycle) : null,
  );
}
