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
import { useResource } from "./useResource";

export function useSpinWaveGammaResource(enabled = true) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.analysis.spinWave.gamma({ signal }),
    [api],
  );
  return useResource<SpinWaveGammaResource>({
    enabled,
    load,
    resolveRevision: (data) => data?.schema_version ?? null,
    resourceKey: ANALYSIS_SPIN_WAVE_GAMMA_V1_PATH,
  });
}

export function useDynamicStructureFactorResource(enabled = true) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.analysis.spinWave.dynamicStructureFactor({ signal }),
    [api],
  );
  return useResource<DynamicStructureFactorResource>({
    enabled,
    load,
    resolveRevision: (data) => data?.schema_version ?? null,
    resourceKey: ANALYSIS_DYNAMIC_STRUCTURE_FACTOR_V1_PATH,
  });
}
