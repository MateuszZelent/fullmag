import { useEffect, useState } from "react";

import type { EigenModeSummary } from "@/components/analyze/eigenTypes";
import { getLiveSessionClient } from "@/src/api/client/LiveSessionClient";

interface UseEigenSpectrumSummaryOptions {
  enabled: boolean;
  cacheKey?: string | null;
}

export function useEigenSpectrumSummary({
  enabled,
  cacheKey = null,
}: UseEigenSpectrumSummaryOptions): EigenModeSummary[] | null {
  const [result, setResult] = useState<{
    cacheKey: string | null;
    modes: EigenModeSummary[] | null;
  }>({ cacheKey: null, modes: null });

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    void getLiveSessionClient()
      .eigen
      .getSpectrum({ signal: controller.signal })
      .then((data) => {
        if (cancelled) return;
        const nextModes = (data as { modes?: EigenModeSummary[] }).modes;
        setResult({ cacheKey, modes: Array.isArray(nextModes) ? nextModes : null });
      })
      .catch((error) => {
        if (cancelled || (error instanceof DOMException && error.name === "AbortError")) {
          return;
        }
        setResult({ cacheKey, modes: null });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [cacheKey, enabled]);

  return enabled && result.cacheKey === cacheKey ? result.modes : null;
}
