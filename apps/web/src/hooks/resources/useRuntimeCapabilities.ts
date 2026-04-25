"use client";

import { useEffect, useState } from "react";
import { getLiveApiClient } from "../../api/client/LiveApiClient";
import type { RuntimeCapabilityMatrix } from "../../api/types";

export interface UseRuntimeCapabilitiesResult {
  capabilities: RuntimeCapabilityMatrix | null;
  loading: boolean;
  error: string | null;
}

export function fetchRuntimeCapabilities(): Promise<RuntimeCapabilityMatrix> {
  return getLiveApiClient().system.getCapabilities();
}

export function useRuntimeCapabilities(): UseRuntimeCapabilitiesResult {
  const [capabilities, setCapabilities] = useState<RuntimeCapabilityMatrix | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetchRuntimeCapabilities()
      .then((next) => {
        if (cancelled) return;
        setCapabilities(next);
        setError(null);
      })
      .catch((nextError) => {
        if (cancelled) return;
        setError(nextError instanceof Error ? nextError.message : "Failed to load runtime capabilities");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { capabilities, loading, error };
}
