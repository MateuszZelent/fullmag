"use client";

import { useCallback, useMemo } from "react";

import {
  DATA_DOMAIN_META_PATH,
  DATA_DOMAIN_TOPOLOGY_PATH,
  DATA_FIELD_VECTOR_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MESHING_SHARED_DOMAIN_QUALITY_DATA_PATH,
  MODEL_SCENE_PATH,
  MODEL_UNIVERSE_PATH,
} from "@/kernel/api/apiPaths";
import type {
  BinaryResourceResult,
  FieldVectorQuery,
} from "@/kernel/api/apiTypes";
import type {
  DecodedFieldVector,
  DecodedMeshQualityData,
  DecodedTopology,
} from "@/kernel/api/codecs";
import { useKernel } from "@/kernel/KernelContext";
import { ResourceCache } from "@/kernel/resources/ResourceCache";
import { useResource } from "@/kernel/resources/useResource";

const topologyCache = new ResourceCache<DecodedTopology>({
  maxBytes: 96 * 1024 * 1024,
});
const fieldVectorCache = new ResourceCache<DecodedFieldVector>({
  maxBytes: 128 * 1024 * 1024,
});
const qualityDataCache = new ResourceCache<DecodedMeshQualityData>({
  maxBytes: 48 * 1024 * 1024,
});

const VIEWPORT_3D_DOMAIN_META_RESOURCE_KEY = DATA_DOMAIN_META_PATH;
const VIEWPORT_3D_DOMAIN_TOPOLOGY_RESOURCE_KEY = DATA_DOMAIN_TOPOLOGY_PATH;
const VIEWPORT_3D_SHARED_DOMAIN_MANIFEST_RESOURCE_KEY =
  MESHING_SHARED_DOMAIN_MANIFEST_PATH;
const VIEWPORT_3D_SHARED_DOMAIN_QUALITY_DATA_RESOURCE_KEY =
  MESHING_SHARED_DOMAIN_QUALITY_DATA_PATH;
const VIEWPORT_3D_SCENE_RESOURCE_KEY = MODEL_SCENE_PATH;
const VIEWPORT_3D_UNIVERSE_RESOURCE_KEY = MODEL_UNIVERSE_PATH;

function resolveDomainMetaRevision(meta: { generation_id: number }) {
  return meta.generation_id;
}

function resolveSharedDomainManifestRevision(
  manifest: { revision?: number | string | null } | null,
) {
  return manifest?.revision ?? null;
}

function resolveTopologyRevision() {
  return (
    topologyCache.peek(VIEWPORT_3D_DOMAIN_TOPOLOGY_RESOURCE_KEY)?.etag ?? null
  );
}

function resolveQualityDataRevision() {
  return (
    qualityDataCache.peek(VIEWPORT_3D_SHARED_DOMAIN_QUALITY_DATA_RESOURCE_KEY)
      ?.etag ?? null
  );
}

function resolveUniverseRevision(universe: { scene_revision: number }) {
  return universe.scene_revision;
}

export function getViewport3DCacheStats() {
  const topologyStats = topologyCache.stats();
  const fieldVectorStats = fieldVectorCache.stats();
  const qualityDataStats = qualityDataCache.stats();

  return {
    byteLength:
      topologyStats.byteLength +
      fieldVectorStats.byteLength +
      qualityDataStats.byteLength,
    entryCount:
      topologyStats.entryCount +
      fieldVectorStats.entryCount +
      qualityDataStats.entryCount,
  };
}

export async function loadCachedBinaryResource<TData>(
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

export function resolveViewport3DFieldVectorResourceKey(
  quantityId: string,
  query: FieldVectorQuery = {},
): string {
  const path = DATA_FIELD_VECTOR_PATH.replace(
    "{quantity_id}",
    encodeURIComponent(quantityId),
  );
  const params = new URLSearchParams();
  if (query.component) params.set("component", query.component);
  if (query.scope_id) params.set("scope_id", query.scope_id);
  if (query.scope_kind) params.set("scope_kind", query.scope_kind);
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

export function resolveViewport3DAirboxFieldVectorResourceKeys(
  quantityId: string,
  airboxParts: readonly { id: string }[],
): Map<string, string> {
  return new Map(
    airboxParts.map((part) => [
      part.id,
      resolveViewport3DFieldVectorResourceKey(quantityId, {
        component: "full",
        scope_id: part.id,
        scope_kind: "airbox",
      }),
    ]),
  );
}

export function resolveViewport3DQuantityFieldVectorResourceKeys(
  quantityIds: readonly string[],
): Map<string, string> {
  return new Map(
    [...new Set(quantityIds)]
      .filter((quantityId) => quantityId.trim().length > 0)
      .sort()
      .map((quantityId) => [
        quantityId,
        resolveViewport3DFieldVectorResourceKey(quantityId, {
          component: "full",
          scope_kind: "full",
        }),
      ]),
  );
}

export function useViewport3DDomainMeta() {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.data.domain.meta({ signal }),
    [api],
  );

  return useResource({
    load,
    resolveRevision: resolveDomainMetaRevision,
    resourceKey: VIEWPORT_3D_DOMAIN_META_RESOURCE_KEY,
  });
}

export function useViewport3DDomainTopology() {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      loadCachedBinaryResource(
        topologyCache,
        VIEWPORT_3D_DOMAIN_TOPOLOGY_RESOURCE_KEY,
        (etag) => api.data.domain.topologyChunked({ etag, signal }),
      ),
    [api],
  );

  return useResource({
    load,
    resolveRevision: resolveTopologyRevision,
    resourceKey: VIEWPORT_3D_DOMAIN_TOPOLOGY_RESOURCE_KEY,
  });
}

export function useViewport3DFieldVector(
  quantityId: string,
  fieldQuery: FieldVectorQuery = {},
  enabled = true,
) {
  const { api } = useKernel();
  const component = fieldQuery.component ?? "full";
  const scopeId = fieldQuery.scope_id ?? null;
  const scopeKind = fieldQuery.scope_kind ?? null;
  const query = useMemo<FieldVectorQuery>(
    () => ({
      component,
      scope_id: scopeId,
      scope_kind: scopeKind,
    }),
    [component, scopeId, scopeKind],
  );
  const resourceKey = useMemo(
    () => resolveViewport3DFieldVectorResourceKey(quantityId, query),
    [quantityId, query],
  );
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      loadCachedBinaryResource(fieldVectorCache, resourceKey, (etag) =>
        api.data.fields.vector(quantityId, query, { etag, signal }),
      ),
    [api, quantityId, query, resourceKey],
  );
  const resolveRevision = useCallback(
    () => fieldVectorCache.peek(resourceKey)?.etag ?? null,
    [resourceKey],
  );

  return useResource({
    enabled,
    load,
    resolveRevision,
    resourceKey,
  });
}

export function useViewport3DAirboxFieldVectors(
  quantityId: string,
  airboxParts: readonly { id: string }[],
  enabled = true,
) {
  const { api } = useKernel();
  const resourceKeys = useMemo(
    () => resolveViewport3DAirboxFieldVectorResourceKeys(quantityId, airboxParts),
    [airboxParts, quantityId],
  );
  const resourceKey = useMemo(() => {
    const suffix = Array.from(resourceKeys.values()).join("|");
    return suffix
      ? `viewport-3d:airbox-field-vectors:${suffix}`
      : "viewport-3d:airbox-field-vectors:none";
  }, [resourceKeys]);
  const load = useCallback(
    async ({ signal }: { signal: AbortSignal }) => {
      const entries = await Promise.all(
        Array.from(resourceKeys, async ([partId, key]) => {
          const data = await loadCachedBinaryResource(
            fieldVectorCache,
            key,
            (etag) =>
              api.data.fields.vector(
                quantityId,
                {
                  component: "full",
                  scope_id: partId,
                  scope_kind: "airbox",
                },
                { etag, signal },
              ),
          );
          return [partId, data] as const;
        }),
      );

      return new Map(
        entries.filter(
          (entry): entry is readonly [string, DecodedFieldVector] =>
            entry[1] !== null,
        ),
      );
    },
    [api, quantityId, resourceKeys],
  );
  const resolveRevision = useCallback(() => {
    const revisions = Array.from(resourceKeys.values()).map(
      (key) => fieldVectorCache.peek(key)?.etag ?? "missing",
    );
    return revisions.length > 0 ? revisions.join("|") : null;
  }, [resourceKeys]);

  return useResource({
    enabled: enabled && resourceKeys.size > 0,
    load,
    resolveRevision,
    resourceKey,
  });
}

export function useViewport3DQuantityFieldVectors(
  quantityIds: readonly string[],
  enabled = true,
) {
  const { api } = useKernel();
  const resourceKeys = useMemo(
    () => resolveViewport3DQuantityFieldVectorResourceKeys(quantityIds),
    [quantityIds],
  );
  const resourceKey = useMemo(() => {
    const suffix = Array.from(resourceKeys.values()).join("|");
    return suffix
      ? `viewport-3d:quantity-field-vectors:${suffix}`
      : "viewport-3d:quantity-field-vectors:none";
  }, [resourceKeys]);
  const load = useCallback(
    async ({ signal }: { signal: AbortSignal }) => {
      const entries = await Promise.all(
        Array.from(resourceKeys, async ([quantityId, key]) => {
          const data = await loadCachedBinaryResource(
            fieldVectorCache,
            key,
            (etag) =>
              api.data.fields.vector(
                quantityId,
                {
                  component: "full",
                  scope_kind: "full",
                },
                { etag, signal },
              ),
          );
          return [quantityId, data] as const;
        }),
      );

      return new Map(
        entries.filter(
          (entry): entry is readonly [string, DecodedFieldVector] =>
            entry[1] !== null,
        ),
      );
    },
    [api, resourceKeys],
  );
  const resolveRevision = useCallback(() => {
    const revisions = Array.from(resourceKeys.values()).map(
      (key) => fieldVectorCache.peek(key)?.etag ?? "missing",
    );
    return revisions.length > 0 ? revisions.join("|") : null;
  }, [resourceKeys]);

  return useResource({
    enabled: enabled && resourceKeys.size > 0,
    load,
    resolveRevision,
    resourceKey,
  });
}

export function useViewport3DMeshQualityData(enabled = true) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      loadCachedBinaryResource(
        qualityDataCache,
        VIEWPORT_3D_SHARED_DOMAIN_QUALITY_DATA_RESOURCE_KEY,
        (etag) => api.meshing.sharedDomain.qualityData({ etag, signal }),
      ),
    [api],
  );

  return useResource({
    enabled,
    load,
    resolveRevision: resolveQualityDataRevision,
    resourceKey: VIEWPORT_3D_SHARED_DOMAIN_QUALITY_DATA_RESOURCE_KEY,
  });
}

export function useViewport3DSharedDomainManifest() {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.meshing.sharedDomainManifest({ signal }),
    [api],
  );

  return useResource({
    load,
    resolveRevision: resolveSharedDomainManifestRevision,
    resourceKey: VIEWPORT_3D_SHARED_DOMAIN_MANIFEST_RESOURCE_KEY,
  });
}

export function useViewport3DScene() {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.model.scene({ signal }),
    [api],
  );

  return useResource({
    load,
    resourceKey: VIEWPORT_3D_SCENE_RESOURCE_KEY,
  });
}

export function useViewport3DUniverse() {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.model.universe({ signal }),
    [api],
  );

  return useResource({
    load,
    resolveRevision: resolveUniverseRevision,
    resourceKey: VIEWPORT_3D_UNIVERSE_RESOURCE_KEY,
  });
}
