"use client";

import { useCallback } from "react";

import { PLATFORM_OUTPUT_STORAGE_PATH } from "../api/apiPaths";
import type { OutputStorageDefaultsResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import { useResource } from "./useResource";

export function useOutputStorageDefaults(enabled = true) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.platform.outputStorageDefaults({ signal }),
    [api],
  );
  return useResource<OutputStorageDefaultsResource>({
    enabled,
    load,
    resolveRevision: () => null,
    resourceKey: PLATFORM_OUTPUT_STORAGE_PATH,
  });
}
