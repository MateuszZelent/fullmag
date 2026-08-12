"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

import {
  DATA_PLANAR_FIELD_EMPTY_MASK_PATH,
  DATA_PLANAR_FIELD_MESH_OVERLAY_PATH,
  DATA_PLANAR_FIELD_META_PATH,
  DATA_PLANAR_FIELD_PROBE_PATH,
  DATA_PLANAR_FIELD_RENDER_PNG_PATH,
  DATA_PLANAR_FIELD_SCALAR_PATH,
  DATA_PLANAR_FIELD_VECTORS_PATH,
} from "../api/apiPaths";
import type {
  BinaryResourceResult,
  PlanarFieldMetaResource,
  PlanarFieldProbeQuery,
  PlanarFieldProbeResource,
  PlanarFieldQuery,
  ResourceRevision,
} from "../api/apiTypes";
import {
  normalizePlanarFieldQuery,
  planarFieldQueryFromMetaLink,
  planarFieldResourceKey,
} from "../api/fieldQueryIdentity";
import { useKernel } from "../KernelContext";

import { ResourceCache } from "./ResourceCache";
import { useResource } from "./useResource";

export { planarFieldQueryFromMetaLink };

interface ResourceHookOptions {
  enabled?: boolean;
}

type BinaryKind = "emptyMask" | "meshOverlay" | "renderPng" | "scalar" | "vectors";

export interface PlanarScalarResource {
  data: ArrayBuffer;
  etag: string | null;
}

const binaryCaches: Record<BinaryKind, ResourceCache<ArrayBuffer>> = {
  emptyMask: new ResourceCache({ maxBytes: 32 * 1024 * 1024 }),
  meshOverlay: new ResourceCache({ maxBytes: 96 * 1024 * 1024 }),
  renderPng: new ResourceCache({ maxBytes: 96 * 1024 * 1024 }),
  scalar: new ResourceCache({ maxBytes: 128 * 1024 * 1024 }),
  vectors: new ResourceCache({ maxBytes: 128 * 1024 * 1024 }),
};

const binaryPaths: Record<BinaryKind, string> = {
  emptyMask: DATA_PLANAR_FIELD_EMPTY_MASK_PATH,
  meshOverlay: DATA_PLANAR_FIELD_MESH_OVERLAY_PATH,
  renderPng: DATA_PLANAR_FIELD_RENDER_PNG_PATH,
  scalar: DATA_PLANAR_FIELD_SCALAR_PATH,
  vectors: DATA_PLANAR_FIELD_VECTORS_PATH,
};

const metaLinkPaths = {
  empty_mask: DATA_PLANAR_FIELD_EMPTY_MASK_PATH,
  mesh_overlay: DATA_PLANAR_FIELD_MESH_OVERLAY_PATH,
  probe: DATA_PLANAR_FIELD_PROBE_PATH,
  render_png: DATA_PLANAR_FIELD_RENDER_PNG_PATH,
  scalar: DATA_PLANAR_FIELD_SCALAR_PATH,
  vectors: DATA_PLANAR_FIELD_VECTORS_PATH,
} as const satisfies Record<keyof PlanarFieldMetaResource["links"], string>;

export function planarFieldQueryFromMetaLinks(
  links: PlanarFieldMetaResource["links"],
): PlanarFieldQuery {
  let canonicalPrefix: string | null = null;
  let canonicalIdentity: string | null = null;
  let canonicalQuery: PlanarFieldQuery | null = null;

  for (const [kind, template] of Object.entries(metaLinkPaths) as [
    keyof PlanarFieldMetaResource["links"],
    string,
  ][]) {
    const link = links[kind];
    const query = planarFieldQueryFromMetaLink(link);
    const pathSuffix = template.split("{monitor_id}")[1];
    const url = new URL(link, "http://fullmag.invalid");
    if (!pathSuffix || !url.pathname.endsWith(pathSuffix)) {
      throw new Error(`Canonical planar metadata ${kind} link has invalid path`);
    }
    const prefix = url.pathname.slice(0, -pathSuffix.length);
    const identity = JSON.stringify(query);
    canonicalPrefix ??= prefix;
    canonicalIdentity ??= identity;
    canonicalQuery ??= query;
    if (prefix !== canonicalPrefix || identity !== canonicalIdentity) {
      throw new Error("Canonical planar metadata links disagree on sample identity");
    }
  }

  if (!canonicalQuery) {
    throw new Error("Canonical planar metadata links are empty");
  }
  return canonicalQuery;
}

export function resolvePlanarFieldResourceKey(
  quantityId: string,
  monitorId: string,
  query: PlanarFieldQuery,
  revision: ResourceRevision | null,
  path: string = DATA_PLANAR_FIELD_META_PATH,
): string {
  return `${planarFieldResourceKey(quantityId, monitorId, query, path)}#revision=${encodeURIComponent(String(revision ?? "none"))}`;
}

export function usePlanarFieldMetaResource(
  quantityId: string,
  monitorId: string,
  query: PlanarFieldQuery = {},
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const stableQuery = useStablePlanarFieldQuery(query);
  const baseKey = planarFieldResourceKey(quantityId, monitorId, stableQuery);
  const revision = useResourceRevision(baseKey);
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.data.fields.planar.meta(quantityId, monitorId, stableQuery, { signal }),
    [api, monitorId, quantityId, stableQuery],
  );
  return useResource<PlanarFieldMetaResource | null>({
    enabled: options.enabled,
    load,
    resourceKey: resolvePlanarFieldResourceKey(
      quantityId,
      monitorId,
      stableQuery,
      revision,
    ),
  });
}

export function usePlanarFieldBinaryResource(
  kind: BinaryKind,
  quantityId: string,
  monitorId: string,
  query: PlanarFieldQuery = {},
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const stableQuery = useStablePlanarFieldQuery(query);
  const path = binaryPaths[kind];
  const baseKey = planarFieldResourceKey(quantityId, monitorId, stableQuery, path);
  const revision = useResourceRevision(baseKey);
  const resourceKey = resolvePlanarFieldResourceKey(
    quantityId,
    monitorId,
    stableQuery,
    revision,
    path,
  );
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      loadCachedPlanarBinary(binaryCaches[kind], resourceKey, (etag) =>
        api.data.fields.planar[kind](quantityId, monitorId, stableQuery, {
          etag,
          signal,
        }),
      ),
    [api, kind, monitorId, quantityId, resourceKey, stableQuery],
  );
  const resolveRevision = useCallback(
    () => binaryCaches[kind].peek(resourceKey)?.etag ?? null,
    [kind, resourceKey],
  );
  return useResource<ArrayBuffer | null>({
    enabled: options.enabled,
    load,
    resolveRevision,
    resourceKey,
  });
}

export function usePlanarScalarResource(
  quantityId: string,
  monitorId: string,
  query: PlanarFieldQuery = {},
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const stableQuery = useStablePlanarFieldQuery(query);
  const path = binaryPaths.scalar;
  const baseKey = planarFieldResourceKey(quantityId, monitorId, stableQuery, path);
  const revision = useResourceRevision(baseKey);
  const resourceKey = resolvePlanarFieldResourceKey(
    quantityId,
    monitorId,
    stableQuery,
    revision,
    path,
  );
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      loadCachedPlanarScalar(binaryCaches.scalar, resourceKey, (etag) =>
        api.data.fields.planar.scalar(quantityId, monitorId, stableQuery, {
          etag,
          signal,
        }),
      ),
    [api, monitorId, quantityId, resourceKey, stableQuery],
  );
  const resolveRevision = useCallback(
    () => binaryCaches.scalar.peek(resourceKey)?.etag ?? null,
    [resourceKey],
  );
  return useResource<PlanarScalarResource | null>({
    enabled: options.enabled,
    load,
    resolveRevision,
    resourceKey,
  });
}

export function usePlanarVectorResource(
  quantityId: string,
  monitorId: string,
  query: PlanarFieldQuery = {},
  options: ResourceHookOptions = {},
) {
  return usePlanarFieldBinaryResource(
    "vectors",
    quantityId,
    monitorId,
    query,
    options,
  );
}

export function usePlanarMaskResource(
  quantityId: string,
  monitorId: string,
  query: PlanarFieldQuery = {},
  options: ResourceHookOptions = {},
) {
  return usePlanarFieldBinaryResource(
    "emptyMask",
    quantityId,
    monitorId,
    query,
    options,
  );
}

export function usePlanarMeshOverlayResource(
  quantityId: string,
  monitorId: string,
  query: PlanarFieldQuery = {},
  options: ResourceHookOptions = {},
) {
  return usePlanarFieldBinaryResource(
    "meshOverlay",
    quantityId,
    monitorId,
    query,
    options,
  );
}

export function usePlanarRenderPngResource(
  quantityId: string,
  monitorId: string,
  query: PlanarFieldQuery = {},
  options: ResourceHookOptions = {},
) {
  return usePlanarFieldBinaryResource(
    "renderPng",
    quantityId,
    monitorId,
    query,
    options,
  );
}

export function usePlanarProbeResource(
  quantityId: string,
  monitorId: string,
  query: PlanarFieldProbeQuery,
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const stableQuery = useMemo<PlanarFieldProbeQuery>(
    () => ({
      sample_token: query.sample_token,
      component: query.component,
      expected_carrier_revision: query.expected_carrier_revision,
      expected_field_revision: query.expected_field_revision,
      expected_mesh_revision: query.expected_mesh_revision,
      expected_monitor_revision: query.expected_monitor_revision,
      expected_scene_revision: query.expected_scene_revision,
      quality: query.quality,
      resolution_x: query.resolution_x,
      resolution_y: query.resolution_y,
      scope_id: query.scope_id,
      scope_kind: query.scope_kind,
      snapshot_id: query.snapshot_id,
      stage_id: query.stage_id,
      u_m: query.u_m,
      v_m: query.v_m,
    }),
    [
      query.sample_token,
      query.component,
      query.expected_carrier_revision,
      query.expected_field_revision,
      query.expected_mesh_revision,
      query.expected_monitor_revision,
      query.expected_scene_revision,
      query.quality,
      query.resolution_x,
      query.resolution_y,
      query.scope_id,
      query.scope_kind,
      query.snapshot_id,
      query.stage_id,
      query.u_m,
      query.v_m,
    ],
  );
  const fieldQuery: PlanarFieldQuery = {
    sample_token: stableQuery.sample_token,
    component: stableQuery.component,
    expected_carrier_revision: stableQuery.expected_carrier_revision,
    expected_field_revision: stableQuery.expected_field_revision,
    expected_mesh_revision: stableQuery.expected_mesh_revision,
    expected_monitor_revision: stableQuery.expected_monitor_revision,
    expected_scene_revision: stableQuery.expected_scene_revision,
    quality: stableQuery.quality,
    resolution_x: stableQuery.resolution_x,
    resolution_y: stableQuery.resolution_y,
    scope_id: stableQuery.scope_id,
    scope_kind: stableQuery.scope_kind,
    snapshot_id: stableQuery.snapshot_id,
    stage_id: stableQuery.stage_id,
  };
  const resourceKey = `${planarFieldResourceKey(quantityId, monitorId, fieldQuery)}#probe=${stableQuery.u_m},${stableQuery.v_m}`;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.data.fields.planar.probe(quantityId, monitorId, stableQuery, { signal }),
    [api, monitorId, quantityId, stableQuery],
  );
  return useResource<PlanarFieldProbeResource | null>({
    enabled: options.enabled,
    load,
    resourceKey,
  });
}

export async function loadCachedPlanarBinary(
  cache: ResourceCache<ArrayBuffer>,
  key: string,
  request: (etag?: string | null) => Promise<BinaryResourceResult<ArrayBuffer>>,
): Promise<ArrayBuffer | null> {
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

export async function loadCachedPlanarScalar(
  cache: ResourceCache<ArrayBuffer>,
  key: string,
  request: (etag?: string | null) => Promise<BinaryResourceResult<ArrayBuffer>>,
): Promise<PlanarScalarResource | null> {
  const cached = cache.get(key);
  const result = await request(cached?.etag);
  if (result.status === "not-modified") {
    if (!cached) {
      throw new Error(`Binary resource ${key} returned 304 without cache entry`);
    }
    return { data: cached.data, etag: cached.etag ?? null };
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
  return { data: result.data, etag: result.etag };
}

function useResourceRevision(resourceKey: string): ResourceRevision | null {
  const { resources } = useKernel();
  const subscribe = useCallback(
    (listener: () => void) => resources.subscribe(resourceKey, listener),
    [resourceKey, resources],
  );
  const getSnapshot = useCallback(
    () => resources.getRevision(resourceKey),
    [resourceKey, resources],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function useStablePlanarFieldQuery(query: PlanarFieldQuery): PlanarFieldQuery {
  return useMemo(
    () =>
      normalizePlanarFieldQuery({
        sample_token: query.sample_token,
        component: query.component,
        expected_carrier_revision: query.expected_carrier_revision,
        expected_field_revision: query.expected_field_revision,
        expected_mesh_revision: query.expected_mesh_revision,
        expected_monitor_revision: query.expected_monitor_revision,
        expected_scene_revision: query.expected_scene_revision,
        include_mesh: query.include_mesh,
        quality: query.quality,
        resolution_x: query.resolution_x,
        resolution_y: query.resolution_y,
        scope_id: query.scope_id,
        scope_kind: query.scope_kind,
        snapshot_id: query.snapshot_id,
        stage_id: query.stage_id,
        vector_budget: query.vector_budget,
      }),
    [
      query.sample_token,
      query.component,
      query.expected_carrier_revision,
      query.expected_field_revision,
      query.expected_mesh_revision,
      query.expected_monitor_revision,
      query.expected_scene_revision,
      query.include_mesh,
      query.quality,
      query.resolution_x,
      query.resolution_y,
      query.scope_id,
      query.scope_kind,
      query.snapshot_id,
      query.stage_id,
      query.vector_budget,
    ],
  );
}
