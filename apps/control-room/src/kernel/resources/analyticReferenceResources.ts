"use client";

import { useCallback } from "react";

import { ANALYSIS_ANALYTIC_REFERENCE_MODELS_PATH } from "../api/apiPaths";
import type { AnalyticReferenceModelCollectionResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import { useResource } from "./useResource";
import { useSessionScopedResourceKey } from "./useSessionScopedResourceKey";

/** Analytic reference models and their declared assumptions (spec 32 §9). */
export function useAnalyticReferenceModelsResource(options: { enabled?: boolean } = {}) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    ANALYSIS_ANALYTIC_REFERENCE_MODELS_PATH,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.analysis.references.analyticModels({ sessionScopeKey, signal }),
    [api],
  );
  return useResource<AnalyticReferenceModelCollectionResource | null>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resourceKey,
  });
}
