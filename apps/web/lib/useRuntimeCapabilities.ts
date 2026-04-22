"use client";

import { useEffect, useState } from "react";
import { getLiveApiClient } from "@/src/api/client/LiveApiClient";
import type { RuntimeCapabilityMatrix } from "@/src/api/types";

export interface UseRuntimeCapabilitiesResult {
  capabilities: RuntimeCapabilityMatrix | null;
  loading: boolean;
  error: string | null;
}

export function useRuntimeCapabilities(): UseRuntimeCapabilitiesResult {
  const [capabilities, setCapabilities] = useState<RuntimeCapabilityMatrix | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const client = getLiveApiClient();

    client
      .system
      .getCapabilities()
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
