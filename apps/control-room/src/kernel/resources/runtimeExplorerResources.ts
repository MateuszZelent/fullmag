"use client";

import { useCallback, useEffect, useMemo } from "react";

import {
  PLATFORM_CAPABILITIES_PATH,
  PLATFORM_COMPUTE_NODES_PATH,
  PLATFORM_HEALTH_PATH,
  PLATFORM_RUNTIME_SERVICE_PATH,
  SIMULATION_COMMANDS_PATH,
} from "../api/apiPaths";
import { ControlRoomApiError } from "../api/ControlRoomApi";
import type {
  CommandDetailResource,
  ComputeNodesResource,
  HealthResource,
  PlatformCapabilitiesResource,
  RuntimeServiceStatusResource,
} from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import type { RuntimeCommandDetailEntry } from "./runtimeExplorerTypes";

import { useSessionScopedResourceKey } from "./useSessionScopedResourceKey";
import { useResource } from "./useResource";
import type { ResourceStatus } from "./resourceTypes";

interface RuntimeExplorerResourceOptions {
  enabled?: boolean;
}

interface PlatformHealthResourceOptions extends RuntimeExplorerResourceOptions {
  pollIntervalMs?: number;
}

export function usePlatformHealthResource({
  enabled = true,
  pollIntervalMs = 0,
}: PlatformHealthResourceOptions = {}) {
  const { api, resources } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.platform.health({ signal }),
    [api],
  );
  const refresh = useCallback(
    () => resources.invalidate(PLATFORM_HEALTH_PATH, Date.now()),
    [resources],
  );
  const resource = useResource<HealthResource>({
    enabled,
    load,
    // Health only feeds the degraded-runtime banner and diagnostics; an
    // unreachable probe must not raise a global resource-failure toast.
    notifyOnError: false,
    resolveRevision: () => null,
    resourceKey: PLATFORM_HEALTH_PATH,
  });
  useBoundedResourcePolling(resource.status, refresh, enabled, pollIntervalMs);
  return resource;
}

export function usePlatformRuntimeServiceResource({
  enabled = true,
  pollIntervalMs = 0,
}: PlatformHealthResourceOptions = {}) {
  const { api, resources } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.platform.runtimeService({ signal }),
    [api],
  );
  const refresh = useCallback(
    () => resources.invalidate(PLATFORM_RUNTIME_SERVICE_PATH, Date.now()),
    [resources],
  );
  const resource = useResource<RuntimeServiceStatusResource>({
    enabled,
    load,
    resolveRevision: (status) =>
      `${status.configured}:${status.state}:${status.reason.code}:${status.reason.message}`,
    resourceKey: PLATFORM_RUNTIME_SERVICE_PATH,
  });
  useBoundedResourcePolling(resource.status, refresh, enabled, pollIntervalMs);
  return resource;
}

function useBoundedResourcePolling(
  status: ResourceStatus,
  refresh: () => void,
  enabled: boolean,
  intervalMs: number,
): void {
  useEffect(() => {
    if (!enabled || intervalMs <= 0 || status === "idle" || status === "loading") {
      return;
    }
    const timer = window.setTimeout(refresh, intervalMs);
    return () => window.clearTimeout(timer);
  }, [enabled, intervalMs, refresh, status]);
}

export function usePlatformCapabilitiesResource({
  enabled = true,
}: RuntimeExplorerResourceOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.platform.capabilities({ signal }),
    [api],
  );
  return useResource<PlatformCapabilitiesResource>({
    enabled,
    load,
    resolveRevision: () => null,
    resourceKey: PLATFORM_CAPABILITIES_PATH,
  });
}

export function computeNodesResourceRevision(data: ComputeNodesResource): string {
  return JSON.stringify({
    schema_version: data.schema_version,
    state: data.state,
    stale_after_seconds: data.stale_after_seconds,
    nodes: data.nodes.map((node) => ({
      node_id: node.node_id,
      state: node.state,
      stale_after_seconds: node.stale_after_seconds,
      snapshot: node.snapshot,
      node_policy: node.node_policy,
    })),
  }) ?? "null";
}

export function usePlatformComputeNodesResource({
  enabled = true,
}: RuntimeExplorerResourceOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.platform.computeNodes({ signal }),
    [api],
  );
  return useResource<ComputeNodesResource>({
    enabled,
    load,
    minRefetchIntervalMs: 5_000,
    resolveRevision: computeNodesResourceRevision,
    resourceKey: PLATFORM_COMPUTE_NODES_PATH,
  });
}

export function useRuntimeCommandDetailsResource(
  commandIds: readonly string[],
  { enabled = true }: RuntimeExplorerResourceOptions = {},
) {
  const { api } = useKernel();
  const stableCommandIds = useMemo(
    () => [...new Set(commandIds)].sort(),
    [commandIds],
  );
  const identity = stableCommandIds.map(encodeURIComponent).join(",");
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    `${SIMULATION_COMMANDS_PATH}:details:${identity || "none"}`,
  );
  const load = useCallback(
    async ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => {
      return loadRuntimeCommandDetailEntries(
        stableCommandIds,
        (commandId) => api.commands.detail(commandId, { sessionScopeKey, signal }),
      );
    },
    [api, stableCommandIds],
  );
  return useResource<RuntimeCommandDetailEntry[]>({
    enabled:
      enabled && stableCommandIds.length > 0 && sessionIdentity !== null,
    load,
    resolveRevision: (details) => details
      .map((detail) => `${detail.commandId}:${detail.revision ?? detail.status}:${detail.error ?? ""}`)
      .join(","),
    resourceKey,
  });
}

export async function loadRuntimeCommandDetailEntries(
  commandIds: readonly string[],
  load: (commandId: string) => Promise<CommandDetailResource>,
): Promise<RuntimeCommandDetailEntry[]> {
  return Promise.all(commandIds.map(async (commandId) => {
    try {
      const data = await load(commandId);
      return {
        commandId,
        data,
        error: null,
        missing: false,
        revision: data.seq,
        status: "ready" as const,
      };
    } catch (error: unknown) {
      if (error instanceof ControlRoomApiError && error.status === 404) {
        return {
          commandId,
          data: null,
          error: error.message,
          missing: true,
          revision: null,
          status: "unavailable" as const,
        };
      }
      return {
        commandId,
        data: null,
        error: error instanceof Error ? error.message : "Command detail request failed.",
        missing: false,
        revision: null,
        status: "error" as const,
      };
    }
  }));
}
