"use client";

/**
 * Hook: fetches domain meta (and topology for FEM) when domain_generation_id changes.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import type { SpatialDomainAdapter } from "../../domain/adapters/SpatialDomainAdapter";
import { createDomainAdapter } from "../../domain/adapters/createDomainAdapter";
import { getLiveApiClient } from "../../api/client/LiveApiClient";
import { ResourceCache } from "../../api/client/cache/ResourceCache";
import { decodeTopology } from "../../api/codecs/topologyCodec";
import { LiveApiError } from "../../api/client/errors/LiveApiError";

interface UseDomainResourceResult {
  adapter: SpatialDomainAdapter | null;
  loading: boolean;
  error: LiveApiError | null;
}

export function useDomainResource(
  domainGenerationId: number | null,
): UseDomainResourceResult {
  const [adapter, setAdapter] = useState<SpatialDomainAdapter | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<LiveApiError | null>(null);
  const fetchedGenRef = useRef<number | null>(null);

  const fetchDomain = useCallback(async (genId: number) => {
    if (fetchedGenRef.current === genId) return;
    setLoading(true);
    setError(null);

      try {
        const client = getLiveApiClient();
        const cacheKey = ResourceCache.domainKey(genId, "adapter");
        const cached = client.getCache().get<SpatialDomainAdapter>(cacheKey);
        if (cached && cached.generationId === genId) {
          fetchedGenRef.current = genId;
          setAdapter(cached.data);
          setLoading(false);
          return;
        }

        const meta = await client.domain.getMeta();

        let topology;
        if (meta.discretization === "fem") {
          const topologyBuffer = await client.domain.getTopology();
        topology = decodeTopology(topologyBuffer);
      }

      const newAdapter = createDomainAdapter(meta, topology);
      client.getCache().invalidateByGeneration(genId);
      client.getCache().set(cacheKey, newAdapter, genId, genId);
      fetchedGenRef.current = genId;
      setAdapter(newAdapter);
      setLoading(false);
    } catch (err) {
      const apiErr =
        err instanceof LiveApiError
          ? err
          : LiveApiError.networkError("domain", err);
      setError(apiErr);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (domainGenerationId != null) {
      fetchDomain(domainGenerationId);
    }
  }, [domainGenerationId, fetchDomain]);

  return { adapter, loading, error };
}
