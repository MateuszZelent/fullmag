"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

import {
  MESHING_SHARED_DOMAIN_CROSS_SECTION_IMAGE_PATH,
  MESHING_SHARED_DOMAIN_CROSS_SECTION_PATH,
  MESHING_SHARED_DOMAIN_CROSS_SECTION_QUALITY_PATH,
} from "../api/apiPaths";
import type {
  BinaryResourceResult,
  CrossSectionImageQuery,
  CrossSectionQualityQuery,
  CrossSectionQuery,
  ResourceRevision,
} from "../api/apiTypes";
import type {
  DecodedCrossSection,
  DecodedCrossSectionQuality,
} from "../api/codecs";
import { useKernel } from "../KernelContext";

import { ResourceCache } from "./ResourceCache";
import { useResource } from "./useResource";

interface ResourceHookOptions {
  enabled?: boolean;
}

const crossSectionCache = new ResourceCache<DecodedCrossSection>({
  maxBytes: 96 * 1024 * 1024,
});
const crossSectionImageCache = new ResourceCache<ArrayBuffer>({
  maxBytes: 96 * 1024 * 1024,
});
const crossSectionQualityCache = new ResourceCache<DecodedCrossSectionQuality>({
  maxBytes: 48 * 1024 * 1024,
});

export const CROSS_SECTION_RESOURCE_BASE_KEY =
  MESHING_SHARED_DOMAIN_CROSS_SECTION_PATH;
export const CROSS_SECTION_IMAGE_RESOURCE_BASE_KEY =
  MESHING_SHARED_DOMAIN_CROSS_SECTION_IMAGE_PATH;
export const CROSS_SECTION_QUALITY_RESOURCE_BASE_KEY =
  MESHING_SHARED_DOMAIN_CROSS_SECTION_QUALITY_PATH;

export function resolveCrossSectionResourceKey(
  query: CrossSectionQuery,
  revision: ResourceRevision | null,
): string {
  const params = new URLSearchParams();
  params.set("include_polygons", String(query.includePolygons));
  params.set("include_wireframe", String(query.includeWireframe));
  params.set("plane", query.plane);
  params.set("position_percent", String(query.positionPercent));
  return `${CROSS_SECTION_RESOURCE_BASE_KEY}?${params.toString()}#revision=${encodeURIComponent(String(revision ?? "none"))}`;
}

export function resolveCrossSectionImageResourceKey(
  query: CrossSectionImageQuery,
  revision: ResourceRevision | null,
): string {
  const stableQuery = normalizeCrossSectionImageQuery(query);
  const params = new URLSearchParams();
  params.set("color_scale", stableQuery.colorScale ?? "viridis");
  if (stableQuery.filterExpression) {
    params.set("filter_expression", stableQuery.filterExpression);
  }
  params.set("legend", String(stableQuery.legend ?? true));
  params.set("metric", stableQuery.metric);
  params.set("plane", stableQuery.plane);
  params.set("position_percent", String(stableQuery.positionPercent));
  params.set("resolution", String(stableQuery.resolution ?? 1024));
  params.set("rotation_degrees", String(stableQuery.rotationDegrees ?? 0));
  params.set("shrink_factor", String(stableQuery.shrinkFactor ?? 1));
  params.set("wireframe", String(stableQuery.wireframe ?? true));
  return `${CROSS_SECTION_IMAGE_RESOURCE_BASE_KEY}?${params.toString()}#revision=${encodeURIComponent(String(revision ?? "none"))}`;
}

export function resolveCrossSectionQualityResourceKey(
  query: CrossSectionQualityQuery,
  revision: ResourceRevision | null,
): string {
  const params = new URLSearchParams();
  params.set("metric", query.metric);
  params.set("plane", query.plane);
  params.set("position_percent", String(query.positionPercent));
  return `${CROSS_SECTION_QUALITY_RESOURCE_BASE_KEY}?${params.toString()}#revision=${encodeURIComponent(String(revision ?? "none"))}`;
}

export function useCrossSectionResource(
  query: CrossSectionQuery,
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const revision = useResourceRevision(CROSS_SECTION_RESOURCE_BASE_KEY);
  const stableQuery = useMemo<CrossSectionQuery>(
    () => ({
      includePolygons: query.includePolygons,
      includeWireframe: query.includeWireframe,
      plane: query.plane,
      positionPercent: query.positionPercent,
    }),
    [
      query.includePolygons,
      query.includeWireframe,
      query.plane,
      query.positionPercent,
    ],
  );
  const resourceKey = useMemo(
    () => resolveCrossSectionResourceKey(stableQuery, revision),
    [stableQuery, revision],
  );
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      loadCachedBinaryResource(crossSectionCache, resourceKey, (etag) =>
        api.meshing.sharedDomain.crossSection(stableQuery, { etag, signal }),
      ),
    [api, resourceKey, stableQuery],
  );
  const resolveRevision = useCallback(
    () => crossSectionCache.peek(resourceKey)?.etag ?? null,
    [resourceKey],
  );

  return useResource<DecodedCrossSection | null>({
    enabled: options.enabled,
    load,
    resolveRevision,
    resourceKey,
  });
}

export function useCrossSectionImageResource(
  query: CrossSectionImageQuery,
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const revision = useResourceRevision(CROSS_SECTION_IMAGE_RESOURCE_BASE_KEY);
  const stableQuery = useMemo(
    () => normalizeCrossSectionImageQuery(query),
    [query],
  );
  const resourceKey = useMemo(
    () => resolveCrossSectionImageResourceKey(stableQuery, revision),
    [stableQuery, revision],
  );
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      loadCachedBinaryResource(crossSectionImageCache, resourceKey, (etag) =>
        api.meshing.sharedDomain.crossSectionImage(stableQuery, {
          etag,
          signal,
        }),
      ),
    [api, resourceKey, stableQuery],
  );
  const resolveRevision = useCallback(
    () => crossSectionImageCache.peek(resourceKey)?.etag ?? null,
    [resourceKey],
  );

  return useResource<ArrayBuffer | null>({
    enabled: options.enabled,
    load,
    resolveRevision,
    resourceKey,
  });
}

export function useCrossSectionQualityResource(
  query: CrossSectionQualityQuery,
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const revision = useResourceRevision(CROSS_SECTION_QUALITY_RESOURCE_BASE_KEY);
  const stableQuery = useMemo<CrossSectionQualityQuery>(
    () => ({
      metric: query.metric,
      plane: query.plane,
      positionPercent: query.positionPercent,
    }),
    [query.metric, query.plane, query.positionPercent],
  );
  const resourceKey = useMemo(
    () => resolveCrossSectionQualityResourceKey(stableQuery, revision),
    [stableQuery, revision],
  );
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      loadCachedBinaryResource(
        crossSectionQualityCache,
        resourceKey,
        (etag) =>
          api.meshing.sharedDomain.crossSectionQuality(stableQuery, {
            etag,
            signal,
          }),
      ),
    [api, resourceKey, stableQuery],
  );
  const resolveRevision = useCallback(
    () => crossSectionQualityCache.peek(resourceKey)?.etag ?? null,
    [resourceKey],
  );

  return useResource<DecodedCrossSectionQuality | null>({
    enabled: options.enabled,
    load,
    resolveRevision,
    resourceKey,
  });
}

async function loadCachedBinaryResource<TData>(
  cache: ResourceCache<TData>,
  key: string,
  request: (etag?: string | null) => Promise<BinaryResourceResult<TData>>,
): Promise<TData | null> {
  const cached = cache.get(key);
  const result = await request(cached?.etag);

  if (result.status === "not-modified") {
    if (!cached) {
      throw new Error(`Binary resource ${key} returned 304 without cache entry`);
    }
    return cached.data;
  }

  if (result.status === "not-applicable") {
    cache.delete(key);
    return null;
  }

  cache.set(key, {
    byteLength: result.byteLength,
    data: result.data,
    etag: result.etag,
  });
  return result.data;
}

function useResourceRevision(resourceKey: string): ResourceRevision | null {
  const { resources } = useKernel();
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      resources.subscribe(resourceKey, onStoreChange),
    [resourceKey, resources],
  );
  const getSnapshot = useCallback(
    () => resources.getRevision(resourceKey),
    [resourceKey, resources],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function normalizeCrossSectionImageQuery(
  query: CrossSectionImageQuery,
): CrossSectionImageQuery {
  return {
    colorScale: query.colorScale ?? "viridis",
    filterExpression: query.filterExpression?.trim() || null,
    legend: query.legend ?? true,
    metric: query.metric,
    plane: query.plane,
    positionPercent: query.positionPercent,
    resolution: query.resolution ?? 1024,
    rotationDegrees: query.rotationDegrees ?? 0,
    shrinkFactor: query.shrinkFactor ?? 1,
    wireframe: query.wireframe ?? true,
  };
}
