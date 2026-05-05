"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  EigenBranchesArtifact,
  EigenModeArtifactV2,
  EigenSpectrumArtifactV2,
} from "@/components/analyze/eigenTypes";
import { getLiveSessionClient } from "../../api/client/LiveSessionClient";
import { LiveApiError } from "../../api/client/errors/LiveApiError";

export interface UseEigenArtifactV2Options {
  enabled?: boolean;
  refreshKey?: string | number | null;
}

export interface UseEigenArtifactV2Result<T> {
  data: T | null;
  loading: boolean;
  error: LiveApiError | null;
  refresh: () => Promise<void>;
}

function toLiveApiError(endpoint: string, err: unknown): LiveApiError {
  return err instanceof LiveApiError
    ? err
    : LiveApiError.networkError(endpoint, err);
}

function useEigenArtifactV2<T>(
  endpoint: string,
  loader: (signal: AbortSignal) => Promise<T>,
  options?: UseEigenArtifactV2Options,
): UseEigenArtifactV2Result<T> {
  const enabled = options?.enabled ?? true;
  const refreshKey = options?.refreshKey ?? null;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<LiveApiError | null>(null);
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) {
      if (mountedRef.current) {
        setData(null);
        setError(null);
        setLoading(false);
      }
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const nextData = await loader(controller.signal);
      if (!mountedRef.current || controller.signal.aborted) {
        return;
      }
      setData(nextData);
      setError(null);
      setLoading(false);
    } catch (err) {
      if (controller.signal.aborted) {
        return;
      }
      if (!mountedRef.current) {
        return;
      }
      setError(toLiveApiError(endpoint, err));
      setLoading(false);
    }
  }, [enabled, endpoint, loader]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      abortRef.current?.abort();
      mountedRef.current = false;
    };
  }, [refresh, refreshKey]);

  return {
    data: enabled ? data : null,
    loading: enabled ? loading : false,
    error: enabled ? error : null,
    refresh,
  };
}

export function useEigenSpectrumV2(
  options?: UseEigenArtifactV2Options,
): UseEigenArtifactV2Result<EigenSpectrumArtifactV2> {
  const loader = useCallback(
    (signal: AbortSignal) =>
      getLiveSessionClient().eigen.getSpectrumV2({
        signal,
      }) as Promise<EigenSpectrumArtifactV2>,
    [],
  );
  return useEigenArtifactV2("eigen-spectrum-v2", loader, options);
}

export function useEigenBranchesV2(
  options?: UseEigenArtifactV2Options,
): UseEigenArtifactV2Result<EigenBranchesArtifact> {
  const loader = useCallback(
    (signal: AbortSignal) =>
      getLiveSessionClient().eigen.getBranchesV2({
        signal,
      }) as Promise<EigenBranchesArtifact>,
    [],
  );
  return useEigenArtifactV2("eigen-branches-v2", loader, options);
}

export function useEigenModeV2(
  sampleIndex: number | null,
  modeIndex: number | null,
  options?: UseEigenArtifactV2Options,
): UseEigenArtifactV2Result<EigenModeArtifactV2> {
  const enabled =
    (options?.enabled ?? true) &&
    Number.isInteger(sampleIndex) &&
    Number.isInteger(modeIndex) &&
    sampleIndex != null &&
    modeIndex != null;
  const loader = useCallback((signal: AbortSignal) => {
    if (sampleIndex == null || modeIndex == null) {
      return Promise.reject(new Error("Missing eigen mode selection"));
    }
    return getLiveSessionClient().eigen.getModeV2(
      sampleIndex,
      modeIndex,
      { signal },
    ) as Promise<EigenModeArtifactV2>;
  }, [modeIndex, sampleIndex]);

  return useEigenArtifactV2("eigen-mode-v2", loader, {
    ...options,
    enabled,
  });
}

export function useEigenDispersionCsv(
  options?: UseEigenArtifactV2Options,
): UseEigenArtifactV2Result<string> {
  const loader = useCallback(
    (signal: AbortSignal) =>
      getLiveSessionClient().eigen.getDispersionCsv({ signal }),
    [],
  );
  return useEigenArtifactV2("eigen-dispersion-csv", loader, options);
}
