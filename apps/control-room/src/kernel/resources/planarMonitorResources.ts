"use client";

import { useCallback, useSyncExternalStore } from "react";

import {
  MODEL_PLANAR_MONITOR_PATH,
  MODEL_PLANAR_MONITORS_PATH,
} from "../api/apiPaths";
import type { PlanarMonitorCollectionResource, PlanarMonitorResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import { useResource } from "./useResource";

interface ResourceHookOptions {
  enabled?: boolean;
}

export function usePlanarMonitorsResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const revision = useResourceRevision(MODEL_PLANAR_MONITORS_PATH);
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.model.planarMonitors.list({ signal }),
    [api],
  );
  return useResource<PlanarMonitorCollectionResource | null>({
    enabled: options.enabled,
    load,
    resourceKey: `${MODEL_PLANAR_MONITORS_PATH}#revision=${String(revision ?? "none")}`,
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
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.model.planarMonitors.get(monitorId, { signal }),
    [api, monitorId],
  );
  return useResource<PlanarMonitorResource | null>({
    enabled: options.enabled,
    load,
    resourceKey: `${baseKey}#revision=${String(revision ?? "none")}`,
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
