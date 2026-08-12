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
      const details = await Promise.all(
        stableCommandIds.map((commandId) =>
          api.commands.detail(commandId, { signal }).catch((error: unknown) => {
            if (error instanceof ControlRoomApiError && error.status === 404) return null;
            throw error;
          }),
        ),
      );
      return details.filter((detail): detail is CommandDetailResource => detail !== null);
    },
    [api, stableCommandIds],
  );
  return useResource<CommandDetailResource[]>({
    enabled: enabled && stableCommandIds.length > 0,
    load,
    resolveRevision: (details) => details.map((detail) => detail.seq).join(","),
    resourceKey: `${SIMULATION_COMMANDS_PATH}:details:${identity || "none"}`,
  });
}
