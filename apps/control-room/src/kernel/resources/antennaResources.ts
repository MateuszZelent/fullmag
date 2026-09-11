"use client";

import { useCallback } from "react";

import {
  DATA_ANTENNA_FIELD_SOLUTION_PATH,
  DATA_ANTENNA_SOURCE_SPECTRUM_PATH,
} from "../api/apiPaths";
import { ControlRoomApiError } from "../api/ControlRoomApi";
import type {
  AntennaFieldSolutionResource,
  AntennaSourceSpectrumResource,
} from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import { useResource } from "./useResource";

export interface AntennaResourceOptions {
  enabled?: boolean;
}

function concretePath(template: string, name: string, value: string): string {
  return template.replace(`{${name}}`, encodeURIComponent(value));
}

function ignoreMissingAntennaResource<T>(error: unknown): T | null {
  if (error instanceof ControlRoomApiError && error.status === 404) return null;
  throw error;
}

export function useAntennaFieldSolutionResource(
  solutionId: string | null | undefined,
  options: AntennaResourceOptions = {},
) {
  const { api } = useKernel();
  const resourceKey = solutionId
    ? concretePath(DATA_ANTENNA_FIELD_SOLUTION_PATH, "solution_id", solutionId)
    : `${DATA_ANTENNA_FIELD_SOLUTION_PATH}:none`;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      solutionId
        ? api.data.antenna
            .fieldSolution(solutionId, { signal })
            .catch(ignoreMissingAntennaResource<AntennaFieldSolutionResource>)
        : Promise.resolve(null),
    [api, solutionId],
  );

  return useResource<AntennaFieldSolutionResource | null>({
    enabled: Boolean(solutionId) && options.enabled !== false,
    load,
    resolveRevision: (data) => data?.content_digest ?? null,
    resourceKey,
  });
}

export function useAntennaSourceSpectrumResource(
  outputId: string | null | undefined,
  options: AntennaResourceOptions = {},
) {
  const { api } = useKernel();
  const resourceKey = outputId
    ? concretePath(DATA_ANTENNA_SOURCE_SPECTRUM_PATH, "output_id", outputId)
    : `${DATA_ANTENNA_SOURCE_SPECTRUM_PATH}:none`;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      outputId
        ? api.data.antenna
            .sourceSpectrum(outputId, { signal })
            .catch(ignoreMissingAntennaResource<AntennaSourceSpectrumResource>)
        : Promise.resolve(null),
    [api, outputId],
  );

  return useResource<AntennaSourceSpectrumResource | null>({
    enabled: Boolean(outputId) && options.enabled !== false,
    load,
    resolveRevision: (data) => data?.content_digest ?? null,
    resourceKey,
  });
}
