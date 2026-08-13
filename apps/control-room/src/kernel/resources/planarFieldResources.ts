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
  isCanonicalU64Decimal,
  normalizePlanarFieldQuery,
  planarFieldResourcePath,
  planarFieldResourceKey,
} from "../api/fieldQueryIdentity";
import { useKernel } from "../KernelContext";

import { ResourceCache } from "./ResourceCache";
import { useResource } from "./useResource";

export type PlanarFieldMetaParseResult =
  | { ok: true; query: PlanarFieldQuery }
  | { error: Error; ok: false };

type PlanarFieldMetaIdentity = Pick<
  PlanarFieldMetaResource,
  | "carrier_revision"
  | "field_revision"
  | "links"
  | "mesh_revision"
  | "monitor_revision"
  | "sample_token"
  | "scene_revision"
>;

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

export function planarFieldQueryFromMeta(
  quantityId: string,
  monitorId: string,
  meta: PlanarFieldMetaIdentity,
): PlanarFieldMetaParseResult {
  try {
    if (
      typeof meta.sample_token !== "string" ||
      !meta.sample_token.startsWith("planar-sample-v2:") ||
      meta.sample_token.length === "planar-sample-v2:".length
    ) {
      throw new Error("Canonical planar metadata sample_token is invalid");
    }
    const metaRevisions = {
      expected_carrier_revision: meta.carrier_revision,
      expected_field_revision: meta.field_revision,
      expected_mesh_revision: meta.mesh_revision,
      expected_monitor_revision: meta.monitor_revision,
      expected_scene_revision: meta.scene_revision,
    } as const;
    for (const [name, revision] of Object.entries(metaRevisions)) {
      requireCanonicalU64(revision, `metadata ${name}`);
    }
    let canonicalIdentity: string | null = null;
    let canonicalQuery: PlanarFieldQuery | null = null;

    for (const [kind, template] of Object.entries(metaLinkPaths) as [
      keyof PlanarFieldMetaResource["links"],
      string,
    ][]) {
      const link = meta.links[kind];
      const query = planarFieldQueryFromMetaLink(link);
      const url = new URL(link, "http://fullmag.invalid");
      const expectedPath = planarFieldResourcePath(
        quantityId,
        monitorId,
        template,
      );
      if (url.pathname !== expectedPath) {
        throw new Error(`Canonical planar metadata ${kind} link has invalid path`);
      }
      const identity = JSON.stringify(query);
      canonicalIdentity ??= identity;
      canonicalQuery ??= query;
      if (identity !== canonicalIdentity) {
        throw new Error("Canonical planar metadata links disagree on sample identity");
      }
    }

    if (!canonicalQuery) {
      throw new Error("Canonical planar metadata links are empty");
    }
    if (canonicalQuery.sample_token !== meta.sample_token) {
      throw new Error(
        "Canonical planar metadata sample_token disagrees with link identity",
      );
    }
    for (const [name, revision] of Object.entries(metaRevisions) as [
      keyof typeof metaRevisions,
      string,
    ][]) {
      if (canonicalQuery[name] !== revision) {
        throw new Error(
          `Canonical planar metadata ${name} disagrees with link identity`,
        );
      }
    }
    return { ok: true, query: canonicalQuery };
  } catch (error) {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
      ok: false,
    };
  }
}

function planarFieldQueryFromMetaLink(link: string): PlanarFieldQuery {
  const expectedOrigin =
    typeof window === "undefined" ? "http://fullmag.invalid" : window.location.origin;
  const url = new URL(link, expectedOrigin);
  if (url.origin !== expectedOrigin) {
    throw new Error("Canonical planar metadata link must be same-origin");
  }
  const required = (name: string): string => {
    const value = url.searchParams.get(name);
    if (!value) {
      throw new Error(`Canonical planar metadata link is missing ${name}`);
    }
    return value;
  };
  const integer = (name: string): number => {
    const value = Number(required(name));
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Canonical planar metadata link has invalid ${name}`);
    }
    return value;
  };
  const revision = (name: string): string =>
    requireCanonicalU64(required(name), `link ${name}`);
  const includeMesh = required("include_mesh");
  if (includeMesh !== "true" && includeMesh !== "false") {
    throw new Error("Canonical planar metadata link has invalid include_mesh");
  }

  return normalizePlanarFieldQuery({
    sample_token: required("sample_token"),
    component: required("component"),
    expected_carrier_revision: revision("expected_carrier_revision"),
    expected_field_revision: revision("expected_field_revision"),
    expected_mesh_revision: revision("expected_mesh_revision"),
    expected_monitor_revision: revision("expected_monitor_revision"),
    expected_scene_revision: revision("expected_scene_revision"),
    include_mesh: includeMesh === "true",
    quality: required("quality"),
    resolution_x: integer("resolution_x"),
    resolution_y: integer("resolution_y"),
    scope_id: url.searchParams.get("scope_id") ?? undefined,
    scope_kind: required("scope_kind"),
    snapshot_id: url.searchParams.get("snapshot_id") ?? undefined,
    stage_id: url.searchParams.get("stage_id") ?? undefined,
  });
}

function requireCanonicalU64(value: string, name: string): string {
  if (!isCanonicalU64Decimal(value)) {
    throw new Error(`Canonical planar ${name} is not a valid u64 decimal`);
  }
  return value;
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
