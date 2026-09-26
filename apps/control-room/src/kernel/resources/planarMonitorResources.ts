"use client";

import { useCallback, useSyncExternalStore } from "react";

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
  const revision = useResourceRevision(MODEL_PLANAR_MONITORS_PATH);
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
    resourceKey: `${scopedResourceKey}#revision=${String(revision ?? "none")}`,
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
  const revision = useResourceRevision(baseKey);
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
    resourceKey: `${scopedResourceKey}#revision=${String(revision ?? "none")}`,
  });
}

function useResourceRevision(resourceKey: string) {
  const { resources } = useKernel();
  const subscribe = useCallback(
    (listener: () => void) => resources.subscribe(resourceKey, listener),
    [resourceKey, resources],
  );
  const getSnapshot = useCallback(
    () => resources.getRevision(resourceKey),
    [resourceKey, resources],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
