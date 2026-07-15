"use client";

import { useCallback } from "react";

import type {
  CurrentTransportListResource,
  OerstedFieldListResource,
  ResourceRevision,
  SpinTorqueListResource,
} from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import { useResource } from "./useResource";

export const CURRENT_TRANSPORTS_RESOURCE_KEY = "model.current-transports";
export const SPIN_TORQUES_RESOURCE_KEY = "model.spin-torques";
export const OERSTED_FIELDS_RESOURCE_KEY = "model.oersted-fields";

interface ResourceHookOptions {
  enabled?: boolean;
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
