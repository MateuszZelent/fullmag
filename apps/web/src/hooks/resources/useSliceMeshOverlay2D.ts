"use client";

import { useEffect, useState } from "react";

import type { JsonResourceResponse } from "@/src/api/types";
import type {
  DomainSliceMeshOverlayQuery,
  MeshOverlay2DResponse,
} from "@/src/api/types";
import {
  getLiveSessionClient,
  type LiveSessionClient,
} from "@/src/api/client/LiveSessionClient";
import { ResourceCache } from "@/src/api/client/cache/ResourceCache";
import { LiveApiError } from "@/src/api/client/errors/LiveApiError";
import type { SliceMeshOverlay2D } from "@/components/preview/fem/sliceMeshOverlay2D";

export interface SliceMeshOverlayRequestParams {
  domainGenerationId: number;
  topologyRevision: number;
  query: DomainSliceMeshOverlayQuery;
}

export interface UseSliceMeshOverlay2DResult {
  overlay: SliceMeshOverlay2D | null;
  loading: boolean;
  error: LiveApiError | null;
}

export type SliceMeshOverlayClient = Pick<LiveSessionClient, "domain" | "getCache">;

export function buildDomainSliceMeshOverlayQueryToken(
  query: DomainSliceMeshOverlayQuery,
): string {
  return [
    query.plane,
    query.cut_world ?? "none",
    query.cut_norm ?? "none",
  ].join(":");
}

export function buildDomainSliceMeshOverlayResourceKey(
  params: SliceMeshOverlayRequestParams,
): string {
  return ResourceCache.domainKey(
    params.domainGenerationId,
    `slice-mesh-overlay:${params.topologyRevision}:${buildDomainSliceMeshOverlayQueryToken(params.query)}`,
  );
}

export function mapDomainSliceMeshOverlayResponse(
  response: MeshOverlay2DResponse,
): SliceMeshOverlay2D {
  return {
    topologyKey:
      response.etag ||
      `domain-slice-mesh-overlay:${response.topology_revision}:${response.plane}:${response.cut_world}`,
    segments: response.segments.map((segment) => ({
      a: segment.a,
      b: segment.b,
    })),
  };
}

export async function loadSliceMeshOverlay2D(
  client: SliceMeshOverlayClient,
  params: SliceMeshOverlayRequestParams,
  signal?: AbortSignal,
): Promise<SliceMeshOverlay2D | null> {
  const cacheKey = buildDomainSliceMeshOverlayResourceKey(params);
  const cached = client.getCache().get<MeshOverlay2DResponse>(cacheKey);
  if (cached && cached.revision === params.topologyRevision) {
    return mapDomainSliceMeshOverlayResponse(cached.data);
  }

  const response: JsonResourceResponse<MeshOverlay2DResponse> =
    await client.domain.getSliceMeshOverlayResponse(params.query, cached?.eTag ?? undefined, {
      cache: "default",
      signal,
    });

  if (response.status === 304) {
    if (!cached?.data) {
      throw new Error("domain slice mesh overlay returned 304 without cached data");
    }
    return mapDomainSliceMeshOverlayResponse(cached.data);
  }
  if (!response.data) {
    return null;
  }

  client.getCache().set(
    cacheKey,
    response.data,
    params.topologyRevision,
    params.domainGenerationId,
    response.headers.get("etag"),
  );
  return mapDomainSliceMeshOverlayResponse(response.data);
}

export function useSliceMeshOverlay2D(
  request: SliceMeshOverlayRequestParams | null,
): UseSliceMeshOverlay2DResult {
  const [overlay, setOverlay] = useState<SliceMeshOverlay2D | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<LiveApiError | null>(null);

  useEffect(() => {
    if (!request) {
      setOverlay(null);
      setLoading(false);
      setError(null);
      return;
    }

    const client = getLiveSessionClient();
    const controller = new AbortController();
    let active = true;

    setLoading(true);
    setError(null);

    void loadSliceMeshOverlay2D(client, request, controller.signal).then(
      (next) => {
        if (!active || controller.signal.aborted) return;
        setOverlay(next);
        setLoading(false);
      },
      (err) => {
        if (!active || controller.signal.aborted) return;
        setError(
          err instanceof LiveApiError
            ? err
            : LiveApiError.networkError("domain/slice/mesh-overlay", err),
        );
        setLoading(false);
      },
    );

    return () => {
      active = false;
      controller.abort();
    };
  }, [
    request?.domainGenerationId,
    request?.topologyRevision,
    request?.query.plane,
    request?.query.cut_world,
    request?.query.cut_norm,
  ]);

  return { overlay, loading, error };
}
