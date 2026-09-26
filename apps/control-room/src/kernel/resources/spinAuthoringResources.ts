"use client";

import { useCallback } from "react";

import type {
  CurrentTransportListResource,
  OerstedFieldListResource,
  ResourceRevision,
  SpinTorqueListResource,
  SpinInterfaceListResource,
  SpinTransportListResource,
} from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import type { ResourceInvalidationController } from "./ResourceInvalidationController";
import type { ResourceKey } from "./resourceTypes";

import { useResource } from "./useResource";
import { PHYSICS_GRAPH_RESOURCE_KEY } from "./physicsGraphResources";
import { useSessionScopedResourceKey } from "./useSessionScopedResourceKey";

export const CURRENT_TRANSPORTS_RESOURCE_KEY = "model.current-transports";
export const SPIN_TORQUES_RESOURCE_KEY = "model.spin-torques";
export const SPIN_TRANSPORTS_RESOURCE_KEY = "model.spin-transports";
export const SPIN_INTERFACES_RESOURCE_KEY = "model.spin-interfaces";
export const OERSTED_FIELDS_RESOURCE_KEY = "model.oersted-fields";

export function transportMutationResourceKeys(
  family: "current_transport" | "spin_transport",
): readonly ResourceKey[] {
  return family === "current_transport"
    ? [CURRENT_TRANSPORTS_RESOURCE_KEY, PHYSICS_GRAPH_RESOURCE_KEY]
    : [
        SPIN_TRANSPORTS_RESOURCE_KEY,
        SPIN_INTERFACES_RESOURCE_KEY,
        PHYSICS_GRAPH_RESOURCE_KEY,
      ];
}

interface ResourceHookOptions {
  enabled?: boolean;
}

export function invalidateSpinAuthoringResources(
  resources: Pick<ResourceInvalidationController, "invalidate">,
  commit: { scene_revision: number },
  resourceKeys: readonly ResourceKey[],
): void {
  const keys = new Set<ResourceKey>([
    ...resourceKeys,
    PHYSICS_GRAPH_RESOURCE_KEY,
  ]);
  for (const resourceKey of keys) {
    resources.invalidate(resourceKey, commit.scene_revision);
  }
}

function sceneRevision(resource: { scene_revision: number } | null | undefined): ResourceRevision | null {
  return resource?.scene_revision ?? null;
}

export function useCurrentTransportsResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    CURRENT_TRANSPORTS_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => api.model.currentTransports({ sessionScopeKey, signal }),
    [api],
  );
  return useResource<CurrentTransportListResource>({
    enabled: options.enabled && sessionIdentity !== null,
    load,
    resolveRevision: sceneRevision,
    resourceKey,
  });
}

export function useSpinTorquesResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    SPIN_TORQUES_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => api.model.spinTorques({ sessionScopeKey, signal }),
    [api],
  );
  return useResource<SpinTorqueListResource>({
    enabled: options.enabled && sessionIdentity !== null,
    load,
    resolveRevision: sceneRevision,
    resourceKey,
  });
}

export function useSpinTransportsResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    SPIN_TRANSPORTS_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => api.model.spinTransports({ sessionScopeKey, signal }),
    [api],
  );
  return useResource<SpinTransportListResource>({
    enabled: options.enabled && sessionIdentity !== null,
    load,
    resolveRevision: sceneRevision,
    resourceKey,
  });
}

export function useSpinInterfacesResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    SPIN_INTERFACES_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => api.model.spinInterfaces({ sessionScopeKey, signal }),
    [api],
  );
  return useResource<SpinInterfaceListResource>({
    enabled: options.enabled && sessionIdentity !== null,
    load,
    resolveRevision: sceneRevision,
    resourceKey,
  });
}

export function useOerstedFieldsResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    OERSTED_FIELDS_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => api.model.oerstedFields({ sessionScopeKey, signal }),
    [api],
  );
  return useResource<OerstedFieldListResource>({
    enabled: options.enabled && sessionIdentity !== null,
    load,
    resolveRevision: sceneRevision,
    resourceKey,
  });
}
