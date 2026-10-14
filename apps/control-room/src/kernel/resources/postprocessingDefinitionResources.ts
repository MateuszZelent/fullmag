"use client";

import { useCallback } from "react";

import { ANALYSIS_POSTPROCESSING_DEFINITIONS_PATH } from "../api/apiPaths";
import type { PostprocessingDefinitionCollectionResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import { useResource } from "./useResource";
import { useSessionScopedResourceKey } from "./useSessionScopedResourceKey";

interface ResourceHookOptions {
  enabled?: boolean;
}

/**
 * User-created Results nodes owned by analysis modules (ADR 0054, spec 32 §8),
 * saved with the project inside the scene document.
 */
export function usePostprocessingDefinitionsResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const { resourceKey: scopedResourceKey, sessionIdentity } =
    useSessionScopedResourceKey(ANALYSIS_POSTPROCESSING_DEFINITIONS_PATH);
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.analysis.postprocessing.definitions.list({ sessionScopeKey, signal }),
    [api],
  );
  return useResource<PostprocessingDefinitionCollectionResource | null>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: (data) => data?.scene_revision ?? null,
    resourceKey: scopedResourceKey,
  });
}
