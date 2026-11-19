"use client";

import { useCallback } from "react";

import {
  MODEL_PLANAR_MONITOR_PATH,
  MODEL_PLANAR_MONITORS_PATH,
} from "../api/apiPaths";
import type { PlanarMonitorCollectionResource, PlanarMonitorResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import { useResource } from "./useResource";
import { useSessionScopedResourceKey } from "./useSessionScopedResourceKey";

interface ResourceHookOptions {
  enabled?: boolean;
}

export function usePlanarMonitorsResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const { resourceKey: scopedResourceKey, sessionIdentity } =
    useSessionScopedResourceKey(MODEL_PLANAR_MONITORS_PATH);
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.model.planarMonitors.list({ sessionScopeKey, signal }),
    [api],
  );
  return useResource<PlanarMonitorCollectionResource | null>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resourceKey: scopedResourceKey,
    revisionKey: MODEL_PLANAR_MONITORS_PATH,
  });
}

export function usePlanarMonitorResource(
  monitorId: string,
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const baseKey = MODEL_PLANAR_MONITOR_PATH.replace(
    "{monitor_id}",
    encodeURIComponent(monitorId),
  );
  const { resourceKey: scopedResourceKey, sessionIdentity } =
    useSessionScopedResourceKey(baseKey);
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.model.planarMonitors.get(monitorId, { sessionScopeKey, signal }),
    [api, monitorId],
  );
  return useResource<PlanarMonitorResource | null>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resourceKey: scopedResourceKey,
    revisionKey: baseKey,
  });
}
