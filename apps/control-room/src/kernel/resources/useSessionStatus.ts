"use client";

import { useCallback, useEffect } from "react";

import type { LiveStatusResource, SessionListResource } from "../api/apiTypes";
import { SESSIONS_PATH } from "../api/apiPaths";
import { useKernel } from "../KernelContext";
import { statusRefreshIntervalMs } from "../realtime/communicationPolicy";

import { useResourceSelector } from "./useResource";
import type { ResourceResult, ResourceStatus } from "./resourceTypes";
import {
  selectSessionLifecycle,
  type SelectedSessionLifecycle,
} from "./sessionLifecycle";
import {
  sessionIdentityRecoveryRevision,
  sessionResourceIdentitiesEqual,
  sessionResourceIdentityFromStatus,
  confirmedSessionResourceIdentity,
  type SessionResourceIdentity,
} from "./sessionResourceIdentity";
import { useSessionCollection } from "./useSessionCollection";

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

function useConfirmedSessionIdentity(
  identity: SessionResourceIdentity | null,
  collection: SessionListResource | null,
): SessionResourceIdentity | null {
  const { resources } = useKernel();
  const recoveryRevision = sessionIdentityRecoveryRevision(identity, collection);
  useEffect(() => {
    // A stable revision deduplicates the same recovery across all hook consumers.
    if (recoveryRevision) {
      resources.invalidate(SESSIONS_PATH, recoveryRevision);
      resources.invalidate(SESSION_STATUS_RESOURCE_KEY, recoveryRevision);
    }
  }, [recoveryRevision, resources]);
  return confirmedSessionResourceIdentity(identity, collection);
}

export function useSessionResourceIdentity(): SessionResourceIdentity | null {
  const sessions = useSessionCollection();
  const identity = useSessionStatusSelector(
    (status) => sessionResourceIdentityFromStatus(status.data),
    { enabled: sessions.state === "ready", isEqual: sessionResourceIdentitiesEqual },
  );
  return useConfirmedSessionIdentity(identity, sessions.resource.data);
}

export interface SessionBootstrapStatus {
  readonly error: Error | null;
  readonly identity: SessionResourceIdentity | null;
  readonly refetch: () => void;
  readonly status: ResourceStatus;
}

/**
 * Expose the current-session initialization result without creating another
 * transport. The workspace needs the status error and its refetch callback in
 * addition to the identity, otherwise a failed current/status request is
 * indistinguishable from a request that is still loading.
 */
export function useSessionBootstrapStatus({
  collection,
  enabled,
}: {
  collection: SessionListResource | null;
  enabled: boolean;
}): SessionBootstrapStatus {
  const selectBootstrapStatus = useCallback(
    (status: ResourceResult<LiveStatusResource>): SessionBootstrapStatus => ({
      error: status.error,
      identity: confirmedSessionResourceIdentity(
        sessionResourceIdentityFromStatus(status.data),
        collection,
      ),
      refetch: status.refetch,
      status: status.status,
    }),
    [collection],
  );
  return useSessionStatusSelector(selectBootstrapStatus, {
    enabled,
    isEqual: sessionBootstrapStatusesEqual,
  });
}

function sessionBootstrapStatusesEqual(
  previous: SessionBootstrapStatus,
  next: SessionBootstrapStatus,
): boolean {
  return (
    previous.status === next.status &&
    previous.error === next.error &&
    previous.refetch === next.refetch &&
    sessionResourceIdentitiesEqual(previous.identity, next.identity)
  );
}

/** Identity and preparation publication share one status subscription. */
export function useSimulationPreparationSessionScope() {
  const sessions = useSessionCollection();
  const scope = useSessionStatusSelector(
    (status) => ({
      sessionIdentity: sessionResourceIdentityFromStatus(status.data),
      preparationRevision: status.status === "ready"
        ? status.data?.resources.simulation_preparation_revision
        : undefined,
    }),
    {
      enabled: sessions.state === "ready",
      isEqual: (previous, next) =>
        sessionResourceIdentitiesEqual(previous.sessionIdentity, next.sessionIdentity) &&
        previous.preparationRevision === next.preparationRevision,
    },
  );
  const sessionIdentity = useConfirmedSessionIdentity(
    scope.sessionIdentity,
    sessions.resource.data,
  );
  return {
    sessionIdentity,
    preparationRevision: sessionIdentity ? scope.preparationRevision : undefined,
  };
}

export function useSessionLifecycle(): SelectedSessionLifecycle | null {
  return useSessionStatusSelector((status) =>
    status.data?.lifecycle ? selectSessionLifecycle(status.data.lifecycle) : null,
  );
}
