"use client";

import { useCallback, useMemo } from "react";

import {
  PLATFORM_CAPABILITIES_PATH,
  PLATFORM_HEALTH_PATH,
  SIMULATION_COMMANDS_PATH,
} from "../api/apiPaths";
import { ControlRoomApiError } from "../api/ControlRoomApi";
import type {
  CommandDetailResource,
  HealthResource,
  PlatformCapabilitiesResource,
} from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import type { RuntimeCommandDetailEntry } from "./runtimeExplorerTypes";

import { useResource } from "./useResource";

interface RuntimeExplorerResourceOptions {
  enabled?: boolean;
}

export function usePlatformHealthResource({
  enabled = true,
}: RuntimeExplorerResourceOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.platform.health({ signal }),
    [api],
  );
  return useResource<HealthResource>({
    enabled,
    load,
    resolveRevision: () => null,
    resourceKey: PLATFORM_HEALTH_PATH,
  });
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
  const load = useCallback(
    async ({ signal }: { signal: AbortSignal }) => {
      return loadRuntimeCommandDetailEntries(
        stableCommandIds,
        (commandId) => api.commands.detail(commandId, { signal }),
      );
    },
    [api, stableCommandIds],
  );
  return useResource<RuntimeCommandDetailEntry[]>({
    enabled: enabled && stableCommandIds.length > 0,
    load,
    resolveRevision: (details) => details
      .map((detail) => `${detail.commandId}:${detail.revision ?? detail.status}:${detail.error ?? ""}`)
      .join(","),
    resourceKey: `${SIMULATION_COMMANDS_PATH}:details:${identity || "none"}`,
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
