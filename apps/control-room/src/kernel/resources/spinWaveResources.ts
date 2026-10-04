"use client";

import { useCallback } from "react";

import {
  ANALYSIS_DYNAMIC_STRUCTURE_FACTOR_V1_PATH,
  ANALYSIS_SPIN_WAVE_GAMMA_V1_PATH,
} from "../api/apiPaths";
import type {
  DynamicStructureFactorResource,
  SpinWaveGammaResource,
} from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import { useSessionScopedResourceKey } from "./useSessionScopedResourceKey";
import { useResource } from "./useResource";

export function useSpinWaveGammaResource(enabled = true) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    ANALYSIS_SPIN_WAVE_GAMMA_V1_PATH,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => api.analysis.spinWave.gamma({ sessionScopeKey, signal }),
    [api],
  );
  return useResource<SpinWaveGammaResource>({
    enabled: enabled && sessionIdentity !== null,
    load,
    resolveRevision: (data) => data?.schema_version ?? null,
    resourceKey,
  });
}

export function useDynamicStructureFactorResource(enabled = true) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    ANALYSIS_DYNAMIC_STRUCTURE_FACTOR_V1_PATH,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.analysis.spinWave.dynamicStructureFactor({ sessionScopeKey, signal }),
    [api],
  );
  return useResource<DynamicStructureFactorResource>({
    enabled: enabled && sessionIdentity !== null,
    load,
    resolveRevision: (data) => data?.schema_version ?? null,
    resourceKey,
  });
}
