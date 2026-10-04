"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";

import type {
  RequestOptions,
} from "../api/apiTypes";
import type {
  ModeCompositionControllerSnapshot,
  ModeCompositionMutationClient,
  ModeCompositionResource,
} from "../visualization/ModeCompositionController";
import { useKernel } from "../KernelContext";
import { useSessionResourceIdentity } from "./useSessionStatus";
import { sessionRequestScopeKey } from "./sessionResourceIdentity";
import { useSessionScopedResourceKey } from "./useSessionScopedResourceKey";
import { useResource } from "./useResource";
import type { ResourceResult } from "./resourceTypes";
import {
  MODE_COMPOSITION_ACTIVE_RESOURCE_KEY,
  resolveModeCompositionRevision,
} from "./modeCompositionResourceModel";

export {
  MODE_COMPOSITION_ACTIVE_RESOURCE_KEY,
  resolveModeCompositionRevision,
} from "./modeCompositionResourceModel";

export function useModeCompositionActiveResource(
  client: Pick<ModeCompositionMutationClient, "getActiveModeComposition">,
  options: { enabled?: boolean } = {},
): ResourceResult<ModeCompositionResource> {
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MODE_COMPOSITION_ACTIVE_RESOURCE_KEY,
  );
  const load = useCallback(
    ({
      sessionScopeKey,
      signal,
    }: {
      sessionScopeKey?: string;
      signal: AbortSignal;
    }) => client.getActiveModeComposition({ sessionScopeKey, signal }),
    [client],
  );

  return useResource({
    abortStaleInflight: true,
    enabled: options.enabled && sessionIdentity !== null,
    load,
    resolveRevision: resolveModeCompositionRevision,
    resourceKey,
  });
}

/**
 * Binds the server-authoritative active-composition resource to the kernel's
 * ephemeral PATCH controller. Realtime has already invalidated this resource;
 * this hook is the only place that feeds its HTTP snapshot back to the
 * controller. It never persists the composition in module state.
 */
export function useModeCompositionControllerResource(
  options: { enabled?: boolean } = {},
): {
  readonly controller: ModeCompositionControllerSnapshot;
  readonly resource: ResourceResult<ModeCompositionResource>;
} {
  const { api, modeComposition } = useKernel();
  const sessionIdentity = useSessionResourceIdentity();
  const sessionScopeKey = sessionRequestScopeKey(sessionIdentity);
  const client = useMemo(
    () => ({
      getActiveModeComposition: (requestOptions?: RequestOptions) =>
        api.visualization.modeComposition.active(requestOptions),
    }),
    [api],
  );
  const resource = useModeCompositionActiveResource(
    client,
    options,
  );
  const controller = useSyncExternalStore(
    (listener) => modeComposition.subscribe(listener),
    () => modeComposition.getSnapshot(),
    () => modeComposition.getSnapshot(),
  );

  useEffect(() => {
    modeComposition.resetForSession(sessionScopeKey);
  }, [modeComposition, sessionScopeKey]);

  useEffect(() => {
    if (resource.status === "ready" && resource.data) {
      modeComposition.acceptResource(resource.data);
    }
  }, [modeComposition, resource.data, resource.revision, resource.status]);

  return { controller, resource };
}
