"use client";

/**
 * Hook: fetches domain meta (and topology for FEM) when domain_generation_id changes.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import type { SpatialDomainAdapter } from "../../domain/adapters/SpatialDomainAdapter";
import { createDomainAdapter } from "../../domain/adapters/createDomainAdapter";
import { getLiveApiClient } from "../../api/client/LiveApiClient";
import { ResourceCache } from "../../api/client/cache/ResourceCache";
import { decodeTopologyOffThread } from "../../api/codecs/decodeOffThread";
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
        const adapterCacheKey = ResourceCache.domainKey(genId, "adapter");
        const topologyCacheKey = ResourceCache.domainKey(genId, "topology");
        const cachedAdapter = client.getCache().get<SpatialDomainAdapter>(adapterCacheKey);
        if (cachedAdapter && cachedAdapter.generationId === genId) {
          fetchedGenRef.current = genId;
          setAdapter(cachedAdapter.data);
          setLoading(false);
          return;
        }

        const meta = await client.domain.getMeta();

        let topology;
        if (meta.discretization === "fem") {
          const cachedTopology = client.getCache().get<ArrayBuffer>(topologyCacheKey);
          let topologyBuffer: ArrayBuffer;
          if (cachedTopology && cachedTopology.generationId === genId) {
            topologyBuffer = cachedTopology.data;
          } else {
            const response = await client.domain.getTopologyResponse({
              cache: "default",
              headers:
                cachedTopology?.eTag != null
                  ? {
                      "If-None-Match": cachedTopology.eTag,
                    }
                  : undefined,
            });
            if (response.status === 304 && cachedTopology) {
              topologyBuffer = cachedTopology.data;
            } else {
              topologyBuffer = response.buffer;
              client.getCache().set(
                topologyCacheKey,
                topologyBuffer,
                genId,
                genId,
                response.headers.get("etag"),
              );
            }
          }
          topology = await decodeTopologyOffThread(topologyBuffer);
        }

        const newAdapter = createDomainAdapter(meta, topology);
        client.getCache().invalidateByGeneration(genId);
        client.getCache().set(adapterCacheKey, newAdapter, genId, genId);
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
