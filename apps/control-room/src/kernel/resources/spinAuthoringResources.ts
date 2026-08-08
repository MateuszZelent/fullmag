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
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.model.currentTransports({ signal }),
    [api],
  );
  return useResource<CurrentTransportListResource>({
    enabled: options.enabled,
    load,
    resolveRevision: sceneRevision,
    resourceKey: CURRENT_TRANSPORTS_RESOURCE_KEY,
  });
}

export function useSpinTorquesResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.model.spinTorques({ signal }),
    [api],
  );
  return useResource<SpinTorqueListResource>({
    enabled: options.enabled,
    load,
    resolveRevision: sceneRevision,
    resourceKey: SPIN_TORQUES_RESOURCE_KEY,
  });
}

export function useSpinTransportsResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.model.spinTransports({ signal }),
    [api],
  );
  return useResource<SpinTransportListResource>({
    enabled: options.enabled,
    load,
    resolveRevision: sceneRevision,
    resourceKey: SPIN_TRANSPORTS_RESOURCE_KEY,
  });
}

export function useSpinInterfacesResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.model.spinInterfaces({ signal }),
    [api],
  );
  return useResource<SpinInterfaceListResource>({
    enabled: options.enabled,
    load,
    resolveRevision: sceneRevision,
    resourceKey: SPIN_INTERFACES_RESOURCE_KEY,
  });
}

export function useOerstedFieldsResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.model.oerstedFields({ signal }),
    [api],
  );
  return useResource<OerstedFieldListResource>({
    enabled: options.enabled,
    load,
    resolveRevision: sceneRevision,
    resourceKey: OERSTED_FIELDS_RESOURCE_KEY,
  });
}
