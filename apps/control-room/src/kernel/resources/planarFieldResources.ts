"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

import {
  DATA_PLANAR_DEFAULT_FIELD_EMPTY_MASK_PATH,
  DATA_PLANAR_DEFAULT_FIELD_MESH_OVERLAY_PATH,
  DATA_PLANAR_DEFAULT_FIELD_PROBE_PATH,
  DATA_PLANAR_DEFAULT_FIELD_RENDER_PNG_PATH,
  DATA_PLANAR_DEFAULT_FIELD_SCALAR_PATH,
  DATA_PLANAR_DEFAULT_FIELD_VECTORS_PATH,
  DATA_PLANAR_FIELD_EMPTY_MASK_PATH,
  DATA_PLANAR_FIELD_MESH_OVERLAY_PATH,
  DATA_PLANAR_FIELD_PROBE_PATH,
  DATA_PLANAR_FIELD_RENDER_PNG_PATH,
  DATA_PLANAR_FIELD_SCALAR_PATH,
  DATA_PLANAR_FIELD_VECTORS_PATH,
} from "../api/apiPaths";
import type {
  BinaryResourceResult,
  PlanarCropState,
  PlanarFieldMetaResource,
  PlanarFieldProbeQuery,
  PlanarFieldProbeResource,
  PlanarFieldProfileQuery,
  PlanarFieldProfileResource,
  PlanarFieldQuery,
  PlanarFieldSource,
  PlanarSampleSourceResource,
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
import { sessionRequestScopeKey, sessionScopedResourceKey } from "./sessionResourceIdentity";
import { useResource } from "./useResource";
import { useSessionResourceIdentity } from "./useSessionStatus";

export type PlanarFieldMetaParseResult =
  | { ok: true; query: PlanarFieldQuery }
  | { error: Error; ok: false };

type PlanarFieldMetaIdentity = Pick<
  PlanarFieldMetaResource,
  | "carrier_revision"
  | "field_revision"
  | "links"
  | "mesh_revision"
  | "sample_token"
  | "scene_revision"
  | "source"
>;

interface ResourceHookOptions {
  enabled?: boolean;
}

type BinaryKind = "emptyMask" | "meshOverlay" | "renderPng" | "scalar" | "vectors";

type SourcePaths = {
  default: string;
  monitor: string;
};

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

const binaryPaths: Record<BinaryKind, SourcePaths> = {
  emptyMask: {
    default: DATA_PLANAR_DEFAULT_FIELD_EMPTY_MASK_PATH,
    monitor: DATA_PLANAR_FIELD_EMPTY_MASK_PATH,
  },
  meshOverlay: {
    default: DATA_PLANAR_DEFAULT_FIELD_MESH_OVERLAY_PATH,
    monitor: DATA_PLANAR_FIELD_MESH_OVERLAY_PATH,
  },
  renderPng: {
    default: DATA_PLANAR_DEFAULT_FIELD_RENDER_PNG_PATH,
    monitor: DATA_PLANAR_FIELD_RENDER_PNG_PATH,
  },
  scalar: {
    default: DATA_PLANAR_DEFAULT_FIELD_SCALAR_PATH,
    monitor: DATA_PLANAR_FIELD_SCALAR_PATH,
  },
  vectors: {
    default: DATA_PLANAR_DEFAULT_FIELD_VECTORS_PATH,
    monitor: DATA_PLANAR_FIELD_VECTORS_PATH,
  },
};

const metaLinkPaths: Record<keyof PlanarFieldMetaResource["links"], SourcePaths> = {
  empty_mask: {
    default: DATA_PLANAR_DEFAULT_FIELD_EMPTY_MASK_PATH,
    monitor: DATA_PLANAR_FIELD_EMPTY_MASK_PATH,
  },
  mesh_overlay: {
    default: DATA_PLANAR_DEFAULT_FIELD_MESH_OVERLAY_PATH,
    monitor: DATA_PLANAR_FIELD_MESH_OVERLAY_PATH,
  },
  probe: {
    default: DATA_PLANAR_DEFAULT_FIELD_PROBE_PATH,
    monitor: DATA_PLANAR_FIELD_PROBE_PATH,
  },
  render_png: {
    default: DATA_PLANAR_DEFAULT_FIELD_RENDER_PNG_PATH,
    monitor: DATA_PLANAR_FIELD_RENDER_PNG_PATH,
  },
  scalar: {
    default: DATA_PLANAR_DEFAULT_FIELD_SCALAR_PATH,
    monitor: DATA_PLANAR_FIELD_SCALAR_PATH,
  },
  vectors: {
    default: DATA_PLANAR_DEFAULT_FIELD_VECTORS_PATH,
    monitor: DATA_PLANAR_FIELD_VECTORS_PATH,
  },
};

/**
 * Sampling-window query parameters (ADR 0080, note 0970
 * `eq-planar-sampling-window`). The backend accepts all four or none.
 */
export const PLANAR_WINDOW_PARAM_KEYS = [
  "window_u_min_m",
  "window_u_max_m",
  "window_v_min_m",
  "window_v_max_m",
] as const;

export type PlanarWindowParamKey = (typeof PLANAR_WINDOW_PARAM_KEYS)[number];
export type PlanarWindowParams = Pick<PlanarFieldQuery, PlanarWindowParamKey>;

/** Query parameters of a crop window; `{}` without a crop. */
export function planarWindowParams(
  crop: PlanarCropState | null | undefined,
): PlanarWindowParams {
  if (!crop) return {};
  const values = [crop.u_min_m, crop.u_max_m, crop.v_min_m, crop.v_max_m];
  if (!values.every(Number.isFinite)) return {};
  return {
    window_u_min_m: String(crop.u_min_m),
    window_u_max_m: String(crop.u_max_m),
    window_v_min_m: String(crop.v_min_m),
    window_v_max_m: String(crop.v_max_m),
  };
}

/** The window carried by a query: all four parameters, or `{}`. */
export function planarWindowFromQuery(query: object | null | undefined): PlanarWindowParams {
  if (!query) return {};
  const window: PlanarWindowParams = {};
  for (const key of PLANAR_WINDOW_PARAM_KEYS) {
    const value = (query as Readonly<Record<string, unknown>>)[key];
    if (value === undefined || value === null || value === "") return {};
    window[key] = String(value);
  }
  return window;
}

function windowFromLink(url: URL): PlanarWindowParams {
  const present = PLANAR_WINDOW_PARAM_KEYS.filter((key) => url.searchParams.has(key));
  if (present.length === 0) return {};
  if (present.length !== PLANAR_WINDOW_PARAM_KEYS.length) {
    throw new Error("Canonical planar metadata link has a partial sampling window");
  }
  const window: PlanarWindowParams = {};
  for (const key of PLANAR_WINDOW_PARAM_KEYS) {
    const value = url.searchParams.get(key) ?? "";
    if (!value.trim() || !Number.isFinite(Number(value))) {
      throw new Error(`Canonical planar metadata link has invalid ${key}`);
    }
    window[key] = value;
  }
  return window;
}

export function planarFieldQueryFromMeta(
  quantityId: string,
  source: PlanarFieldSource,
  meta: PlanarFieldMetaIdentity,
): PlanarFieldMetaParseResult {
  try {
    if (
      typeof meta.sample_token !== "string" ||
      !meta.sample_token.startsWith("planar-sample-v3:") ||
      meta.sample_token.length === "planar-sample-v3:".length
    ) {
      throw new Error("Canonical planar metadata sample_token is invalid");
    }
    assertMetaSourceMatches(source, meta.source);
    const sourceRevision =
      meta.source.kind === "default"
        ? meta.source.default_slice_revision
        : meta.source.monitor_revision;
    const metaRevisions = {
      expected_carrier_revision: meta.carrier_revision,
      expected_field_revision: meta.field_revision,
      expected_mesh_revision: meta.mesh_revision,
      ...(source.kind === "default"
        ? { expected_source_revision: sourceRevision }
        : { expected_monitor_revision: sourceRevision }),
      expected_scene_revision: meta.scene_revision,
    } as const;
    for (const [name, revision] of Object.entries(metaRevisions)) {
      requireCanonicalU64(revision, `metadata ${name}`);
    }
    let canonicalIdentity: string | null = null;
    let canonicalQuery: PlanarFieldQuery | null = null;

    for (const [kind, template] of Object.entries(metaLinkPaths) as [
      keyof PlanarFieldMetaResource["links"],
      SourcePaths,
    ][]) {
      const link = meta.links[kind];
      const query = planarFieldQueryFromMetaLink(link);
      const url = new URL(link, "http://fullmag.invalid");
      const expectedPath = planarFieldResourcePath(
        quantityId,
        source,
        template[source.kind],
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

function assertMetaSourceMatches(
  source: PlanarFieldSource,
  metaSource: PlanarSampleSourceResource,
): void {
  if (source.kind === "default") {
    if (metaSource.kind !== "default") {
      throw new Error("Canonical planar metadata source family disagrees");
    }
    return;
  }
  if (metaSource.kind !== "monitor" || metaSource.monitor_id !== source.monitorId) {
    throw new Error("Canonical planar metadata source family disagrees");
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

  const sampleWindow = windowFromLink(url);
  return normalizePlanarFieldQuery({
    sample_token: required("sample_token"),
    component: required("component"),
    expected_carrier_revision: revision("expected_carrier_revision"),
    expected_field_revision: revision("expected_field_revision"),
    expected_mesh_revision: revision("expected_mesh_revision"),
    ...(url.searchParams.has("expected_monitor_revision")
      ? { expected_monitor_revision: revision("expected_monitor_revision") }
      : { expected_source_revision: revision("expected_source_revision") }),
    expected_scene_revision: revision("expected_scene_revision"),
    include_mesh: includeMesh === "true",
    quality: required("quality"),
    resolution_x: integer("resolution_x"),
    resolution_y: integer("resolution_y"),
    scope_id: url.searchParams.get("scope_id") ?? undefined,
    scope_kind: required("scope_kind"),
    scope_region_id: url.searchParams.get("scope_region_id") ?? undefined,
    snapshot_id: url.searchParams.get("snapshot_id") ?? undefined,
    stage_id: url.searchParams.get("stage_id") ?? undefined,
    ...positionOverrideFromLink(url),
    ...sampleWindow,
  });
}

/** Carry the exact physical plane (or the existing multislice fraction) into replay. */
function positionOverrideFromLink(url: URL): Pick<PlanarFieldQuery, "position_fraction" | "position_m"> {
  const fraction = url.searchParams.get("position_fraction");
  const absolute = url.searchParams.get("position_m");
  if (fraction !== null && absolute !== null) {
    throw new Error("Canonical planar metadata link has conflicting position overrides");
  }
  if (absolute !== null) {
    const value = Number(absolute);
    if (!absolute.trim() || !Number.isFinite(value)) {
      throw new Error("Canonical planar metadata link has invalid position_m");
    }
    return { position_m: value };
  }
  if (fraction === null) return {};
  const value = Number(fraction);
  if (!fraction.trim() || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("Canonical planar metadata link has invalid position_fraction");
  }
  return { position_fraction: value };
}

function requireCanonicalU64(value: string, name: string): string {
  if (!isCanonicalU64Decimal(value)) {
    throw new Error(`Canonical planar ${name} is not a valid u64 decimal`);
  }
  return value;
}

export function resolvePlanarFieldResourceKey(
  quantityId: string,
  source: PlanarFieldSource,
  query: PlanarFieldQuery,
  revision: ResourceRevision | null,
  path?: string,
): string {
  return `${planarFieldResourceKey(quantityId, source, query, path)}#revision=${encodeURIComponent(String(revision ?? "none"))}`;
}

export function usePlanarFieldMetaResource(
  quantityId: string,
  source: PlanarFieldSource,
  query: PlanarFieldQuery = {},
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const sessionIdentity = useSessionResourceIdentity();
  const stableQuery = useStablePlanarFieldQuery(query);
  const baseKey = planarFieldResourceKey(quantityId, source, stableQuery);
  const revision = useResourceRevision(baseKey);
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.data.fields.planar.meta(quantityId, source, stableQuery, { sessionScopeKey, signal }),
    [api, quantityId, source, stableQuery],
  );
  return useResource<PlanarFieldMetaResource | null>({
    // The 2D stage reports planar failures inline; a toast would repeat
    // them with every revision-scoped resource key.
    notifyOnError: false,
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resourceKey: sessionIdentity
      ? sessionScopedResourceKey(
          sessionIdentity,
          resolvePlanarFieldResourceKey(
            quantityId,
            source,
            stableQuery,
            revision,
          ),
        )
      : resolvePlanarFieldResourceKey(quantityId, source, stableQuery, revision),
  });
}

export function usePlanarFieldBinaryResource(
  kind: BinaryKind,
  quantityId: string,
  source: PlanarFieldSource,
  query: PlanarFieldQuery = {},
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const sessionIdentity = useSessionResourceIdentity();
  const stableQuery = useStablePlanarFieldQuery(query);
  const path = binaryPaths[kind][source.kind];
  const baseKey = planarFieldResourceKey(quantityId, source, stableQuery, path);
  const revision = useResourceRevision(baseKey);
  const unscopedResourceKey = resolvePlanarFieldResourceKey(
    quantityId,
    source,
    stableQuery,
    revision,
    path,
  );
  const resourceKey = sessionIdentity
    ? sessionScopedResourceKey(sessionIdentity, unscopedResourceKey)
    : unscopedResourceKey;
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      loadCachedPlanarBinary(binaryCaches[kind], resourceKey, (etag) =>
        api.data.fields.planar[kind](quantityId, source, stableQuery, {
          etag,
          sessionScopeKey,
          signal,
        }),
      ),
    [api, kind, quantityId, resourceKey, source, stableQuery],
  );
  const resolveRevision = useCallback(
    () => binaryCaches[kind].peek(resourceKey)?.etag ?? null,
    [kind, resourceKey],
  );
  return useResource<ArrayBuffer | null>({
    notifyOnError: false,
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision,
    resourceKey,
  });
}

export function usePlanarScalarResource(
  quantityId: string,
  source: PlanarFieldSource,
  query: PlanarFieldQuery = {},
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const sessionIdentity = useSessionResourceIdentity();
  const stableQuery = useStablePlanarFieldQuery(query);
  const path = binaryPaths.scalar[source.kind];
  const baseKey = planarFieldResourceKey(quantityId, source, stableQuery, path);
  const revision = useResourceRevision(baseKey);
  const unscopedResourceKey = resolvePlanarFieldResourceKey(
    quantityId,
    source,
    stableQuery,
    revision,
    path,
  );
  const resourceKey = sessionIdentity
    ? sessionScopedResourceKey(sessionIdentity, unscopedResourceKey)
    : unscopedResourceKey;
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      loadCachedPlanarScalar(binaryCaches.scalar, resourceKey, (etag) =>
        api.data.fields.planar.scalar(quantityId, source, stableQuery, {
          etag,
          sessionScopeKey,
          signal,
        }),
      ),
    [api, quantityId, resourceKey, source, stableQuery],
  );
  const resolveRevision = useCallback(
    () => binaryCaches.scalar.peek(resourceKey)?.etag ?? null,
    [resourceKey],
  );
  return useResource<PlanarScalarResource | null>({
    notifyOnError: false,
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision,
    resourceKey,
  });
}

export function usePlanarVectorResource(
  quantityId: string,
  source: PlanarFieldSource,
  query: PlanarFieldQuery = {},
  options: ResourceHookOptions = {},
) {
  return usePlanarFieldBinaryResource(
    "vectors",
    quantityId,
    source,
    query,
    options,
  );
}

export function usePlanarMaskResource(
  quantityId: string,
  source: PlanarFieldSource,
  query: PlanarFieldQuery = {},
  options: ResourceHookOptions = {},
) {
  return usePlanarFieldBinaryResource(
    "emptyMask",
    quantityId,
    source,
    query,
    options,
  );
}

export function usePlanarMeshOverlayResource(
  quantityId: string,
  source: PlanarFieldSource,
  query: PlanarFieldQuery = {},
  options: ResourceHookOptions = {},
) {
  return usePlanarFieldBinaryResource(
    "meshOverlay",
    quantityId,
    source,
    query,
    options,
  );
}

export function usePlanarRenderPngResource(
  quantityId: string,
  source: PlanarFieldSource,
  query: PlanarFieldQuery = {},
  options: ResourceHookOptions = {},
) {
  return usePlanarFieldBinaryResource(
    "renderPng",
    quantityId,
    source,
    query,
    options,
  );
}

const PROBE_QUERY_KEYS = [
  "sample_token",
  "component",
  "expected_carrier_revision",
  "expected_field_revision",
  "expected_mesh_revision",
  "expected_monitor_revision",
  "expected_source_revision",
  "expected_scene_revision",
  "nearest",
  "position_fraction",
  "position_m",
  "quality",
  "resolution_x",
  "resolution_y",
  "scope_id",
  "scope_kind",
  "scope_region_id",
  "snapshot_id",
  "stage_id",
  "u_m",
  "v_m",
  ...PLANAR_WINDOW_PARAM_KEYS,
] as const satisfies readonly (keyof PlanarFieldProbeQuery)[];

const WINDOW_KEY_SET: ReadonlySet<string> = new Set(PLANAR_WINDOW_PARAM_KEYS);

/**
 * The exact parameters a planar probe sends: the raster's sample identity,
 * its window (all four or none) and the optional `nearest=node`.
 */
export function planarProbeRequestQuery(query: PlanarFieldProbeQuery): PlanarFieldProbeQuery {
  const window = planarWindowFromQuery(query);
  const normalized: Record<string, unknown> = {};
  for (const key of PROBE_QUERY_KEYS) {
    const value = WINDOW_KEY_SET.has(key)
      ? window[key as PlanarWindowParamKey]
      : query[key];
    if (value !== undefined && value !== null && value !== "") normalized[key] = value;
  }
  return normalized as unknown as PlanarFieldProbeQuery;
}

function planarProbeResourceKey(
  quantityId: string,
  source: PlanarFieldSource,
  query: PlanarFieldProbeQuery,
): string {
  const { nearest, u_m: uM, v_m: vM, ...fieldQuery } = query;
  return `${planarFieldResourceKey(quantityId, source, fieldQuery)}#probe=${uM},${vM}${nearest ? `&nearest=${nearest}` : ""}`;
}

export function usePlanarProbeResource(
  quantityId: string,
  source: PlanarFieldSource,
  query: PlanarFieldProbeQuery,
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const sessionIdentity = useSessionResourceIdentity();
  const queryKey = JSON.stringify(planarProbeRequestQuery(query));
  const stableQuery = useMemo(
    () => JSON.parse(queryKey) as PlanarFieldProbeQuery,
    [queryKey],
  );
  const unscopedResourceKey = planarProbeResourceKey(quantityId, source, stableQuery);
  const resourceKey = sessionIdentity
    ? sessionScopedResourceKey(sessionIdentity, unscopedResourceKey)
    : unscopedResourceKey;
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.data.fields.planar.probe(quantityId, source, stableQuery, { sessionScopeKey, signal }),
    [api, quantityId, source, stableQuery],
  );
  return useResource<PlanarFieldProbeResource | null>({
    notifyOnError: false,
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resourceKey,
  });
}

export type PlanarProbeLoader = (
  quantityId: string,
  source: PlanarFieldSource,
  query: PlanarFieldProbeQuery,
  signal: AbortSignal,
) => Promise<PlanarFieldProbeResource>;

/**
 * Session-scoped probe loader for pointer-driven reads (the 2D inspect
 * tool). Each hover position is a one-shot read that the caller debounces
 * and aborts, so it does not go through the resource cache.
 */
export function usePlanarProbeLoader(): PlanarProbeLoader | null {
  const { api } = useKernel();
  const sessionIdentity = useSessionResourceIdentity();
  const sessionScopeKey = sessionRequestScopeKey(sessionIdentity);
  return useMemo(
    () => sessionScopeKey === null
      ? null
      : (quantityId, source, query, signal) =>
          api.data.fields.planar.probe(
            quantityId,
            source,
            planarProbeRequestQuery(query),
            { sessionScopeKey, signal },
          ),
    [api, sessionScopeKey],
  );
}

/**
 * Line profile of the current planar sample (F6 B1). A derived resource of the
 * same sample token as the raster; disabled while no segment is drawn.
 */
export function usePlanarProfileResource(
  quantityId: string,
  source: PlanarFieldSource,
  query: PlanarFieldProfileQuery | null,
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const sessionIdentity = useSessionResourceIdentity();
  const queryKey = query ? JSON.stringify(normalizeProfileQuery(query)) : null;
  const stableQuery = useMemo<PlanarFieldProfileQuery | null>(
    () => (queryKey ? (JSON.parse(queryKey) as PlanarFieldProfileQuery) : null),
    [queryKey],
  );
  const unscopedResourceKey = stableQuery
    ? `${planarFieldResourceKey(quantityId, source, profileFieldQuery(stableQuery))}#profile=${stableQuery.u0_m},${stableQuery.v0_m},${stableQuery.u1_m},${stableQuery.v1_m},${stableQuery.samples ?? ""}`
    : `planar-profile:${quantityId}:none`;
  const resourceKey = sessionIdentity
    ? sessionScopedResourceKey(sessionIdentity, unscopedResourceKey)
    : unscopedResourceKey;
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      stableQuery
        ? api.data.fields.planar.profile(quantityId, source, stableQuery, { sessionScopeKey, signal })
        : Promise.resolve(null),
    [api, quantityId, source, stableQuery],
  );
  return useResource<PlanarFieldProfileResource | null>({
    notifyOnError: false,
    enabled: options.enabled !== false && sessionIdentity !== null && stableQuery !== null,
    load,
    resourceKey,
  });
}

const PROFILE_QUERY_KEYS = [
  "sample_token",
  "component",
  "expected_carrier_revision",
  "expected_field_revision",
  "expected_mesh_revision",
  "expected_monitor_revision",
  "expected_source_revision",
  "expected_scene_revision",
  "quality",
  "resolution_x",
  "resolution_y",
  "samples",
  "scope_id",
  "scope_kind",
  "scope_region_id",
  "snapshot_id",
  "stage_id",
  "u0_m",
  "u1_m",
  "v0_m",
  "v1_m",
  "position_fraction",
  "position_m",
] as const satisfies readonly (keyof PlanarFieldProfileQuery)[];

function normalizeProfileQuery(query: PlanarFieldProfileQuery): PlanarFieldProfileQuery {
  const normalized: Record<string, unknown> = {};
  for (const key of PROFILE_QUERY_KEYS) {
    const value = query[key];
    if (value !== undefined && value !== null && value !== "") normalized[key] = value;
  }
  return { ...normalized, ...planarWindowFromQuery(query) } as PlanarFieldProfileQuery;
}

function profileFieldQuery(query: PlanarFieldProfileQuery): PlanarFieldQuery {
  const {
    samples: _samples, u0_m: _u0, u1_m: _u1, v0_m: _v0, v1_m: _v1,
    ...fieldQuery
  } = query;
  return fieldQuery;
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
      expected_source_revision: query.expected_source_revision,
      expected_scene_revision: query.expected_scene_revision,
        include_mesh: query.include_mesh,
        position_fraction: query.position_fraction,
        position_m: query.position_m,
        quality: query.quality,
        resolution_x: query.resolution_x,
        resolution_y: query.resolution_y,
        scope_id: query.scope_id,
        scope_kind: query.scope_kind,
        scope_region_id: query.scope_region_id,
        snapshot_id: query.snapshot_id,
        stage_id: query.stage_id,
        vector_budget: query.vector_budget,
        window_u_min_m: query.window_u_min_m,
        window_u_max_m: query.window_u_max_m,
        window_v_min_m: query.window_v_min_m,
        window_v_max_m: query.window_v_max_m,
      }),
    [
      query.sample_token,
      query.component,
      query.expected_carrier_revision,
      query.expected_field_revision,
      query.expected_mesh_revision,
      query.expected_monitor_revision,
      query.expected_source_revision,
      query.expected_scene_revision,
      query.include_mesh,
      query.position_fraction,
      query.position_m,
      query.quality,
      query.resolution_x,
      query.resolution_y,
      query.scope_id,
      query.scope_kind,
      query.scope_region_id,
      query.snapshot_id,
      query.stage_id,
      query.vector_budget,
      query.window_u_min_m,
      query.window_u_max_m,
      query.window_v_min_m,
      query.window_v_max_m,
    ],
  );
}
