"use client";

import { useCallback } from "react";

import { PLATFORM_COMPUTE_PREVIEW_PATH } from "../api/apiPaths";
import type { ComputePreviewResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import {
  isComputePreviewScopeCurrent,
  type PreparedComputeExecutionPreview,
} from "./computeExecutionPreviewRequest";
import { useResource } from "./useResource";

/** Explicit prepared inputs only. Changing the draft requires a new preparation.
 * Old previews cannot survive a session epoch or API-client scope change.
 */
export function useComputeExecutionPreviewResource(
  prepared: PreparedComputeExecutionPreview | null,
  sessionScope: string | null,
) {
  const { api } = useKernel();
  const enabled = isComputePreviewScopeCurrent(prepared, api.resourceCacheScope, sessionScope);
  const resourceKey = prepared
    ? `${PLATFORM_COMPUTE_PREVIEW_PATH}|${prepared.sessionScope}|body=${prepared.bodySha256}`
    : `${PLATFORM_COMPUTE_PREVIEW_PATH}|unprepared`;
  const load = useCallback(async ({ signal }: { signal: AbortSignal }) => {
    if (!prepared || !isComputePreviewScopeCurrent(prepared, api.resourceCacheScope, sessionScope)) {
      throw new Error("Compute preview inputs belong to an earlier session or API scope.");
    }
    const response = await api.platform.computeExecutionPreview(prepared.request, { signal });
    if (response.profile_catalog_revision !== prepared.request.expected_profile_catalog_revision) {
      throw new Error("Compute preview returned a different profile catalogue revision.");
    }
    return response;
  }, [api, prepared, sessionScope]);
  return useResource<ComputePreviewResource>({
    enabled,
    abortStaleInflight: true,
    load,
    resourceKey,
    resolveRevision: (response) => response.preview_id,
  });
}
