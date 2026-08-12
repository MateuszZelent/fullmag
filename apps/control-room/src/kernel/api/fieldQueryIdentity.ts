import {
  DATA_FIELD_VECTOR_PATH,
  DATA_PLANAR_FIELD_META_PATH,
} from "./apiPaths";
import type { FieldVectorQuery, PlanarFieldQuery } from "./apiTypes";
import { resolveCanonicalQuantityId } from "./quantityIds";

export interface CanonicalFieldVectorQuery {
  readonly component: string;
  readonly componentExplicit: boolean;
  readonly geometryScope?: string;
  readonly maxSamples?: number;
  readonly ownerObjectId?: string;
  readonly phaseRad?: number;
  readonly quantityId: string;
  readonly scopeId?: string;
  readonly scopeKind: string;
  readonly scopeKindExplicit: boolean;
  readonly snapshotId?: string;
  readonly stageId?: string;
  readonly view?: string;
}

const FIELD_VECTOR_QUERY_ORDER = [
  "component",
  "geometry_scope",
  "max_samples",
  "owner_object_id",
  "phase_rad",
  "scope_id",
  "scope_kind",
  "snapshot_id",
  "stage_id",
  "view",
] as const;

const FIELD_VECTOR_COMPONENT_EVIDENCE_ALIASES: Readonly<Record<string, string>> = {
  abs_x: "abs_c0",
  abs_y: "abs_c1",
  abs_z: "abs_c2",
  "expr:abs_x": "abs_c0",
  "expr:abs_y": "abs_c1",
  "expr:abs_z": "abs_c2",
  "expr:m2": "magnitude_squared",
  "expr:magnitude_squared": "magnitude_squared",
  x: "c0",
  y: "c1",
  z: "c2",
};

function nonEmptyString(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function fieldVectorComponentEvidenceIdentity(value: string): string {
  const normalized = value.trim().toLowerCase();
  return FIELD_VECTOR_COMPONENT_EVIDENCE_ALIASES[normalized] ?? normalized;
}

export function fieldVectorComponentsSemanticallyEqual(
  left: string,
  right: string,
): boolean {
  return (
    fieldVectorComponentEvidenceIdentity(left) ===
    fieldVectorComponentEvidenceIdentity(right)
  );
}

function canonicalScopeId(scopeKind: string, scopeId: string | undefined): string | undefined {
  if (!scopeId) return undefined;
  if (scopeKind !== "object") return scopeId;
  const prefix = "object:";
  return scopeId.startsWith(prefix) ? scopeId.slice(prefix.length) : scopeId;
}

export function canonicalFieldVectorQuery(
  quantityId: string,
  query: FieldVectorQuery = {},
): CanonicalFieldVectorQuery {
  const scopeKind = nonEmptyString(query.scope_kind) ?? "full";
  const component = nonEmptyString(query.component);
  return {
    component: component ?? "full",
    componentExplicit: component !== undefined,
    geometryScope: nonEmptyString(query.geometry_scope),
    maxSamples: finiteNumber(query.max_samples),
    ownerObjectId: nonEmptyString(query.owner_object_id),
    phaseRad: finiteNumber(query.phase_rad),
    quantityId: resolveCanonicalQuantityId(quantityId),
    scopeId: canonicalScopeId(scopeKind, nonEmptyString(query.scope_id)),
    scopeKind,
    scopeKindExplicit: nonEmptyString(query.scope_kind) !== undefined,
    snapshotId: nonEmptyString(query.snapshot_id),
    stageId: nonEmptyString(query.stage_id),
    view: nonEmptyString(query.view),
  };
}

export function canonicalFieldVectorQueryParams(
  query: CanonicalFieldVectorQuery,
): Record<(typeof FIELD_VECTOR_QUERY_ORDER)[number], string | undefined> {
  return {
    component: query.componentExplicit ? query.component : undefined,
    geometry_scope: query.geometryScope,
    max_samples: query.maxSamples === undefined ? undefined : String(query.maxSamples),
    owner_object_id: query.ownerObjectId,
    phase_rad: query.phaseRad === undefined ? undefined : String(query.phaseRad),
    scope_id: query.scopeId,
    scope_kind: query.scopeKindExplicit ? query.scopeKind : undefined,
    snapshot_id: query.snapshotId,
    stage_id: query.stageId,
    view: query.view,
  };
}

export function canonicalFieldVectorQueriesEqual(
  left: CanonicalFieldVectorQuery,
  right: CanonicalFieldVectorQuery,
): boolean {
  return (
    left.component === right.component &&
    left.geometryScope === right.geometryScope &&
    left.maxSamples === right.maxSamples &&
    left.ownerObjectId === right.ownerObjectId &&
    left.phaseRad === right.phaseRad &&
    left.quantityId === right.quantityId &&
    left.scopeId === right.scopeId &&
    left.scopeKind === right.scopeKind &&
    left.snapshotId === right.snapshotId &&
    left.stageId === right.stageId &&
    left.view === right.view
  );
}

export function serializeCanonicalFieldVectorResourceKey(
  query: CanonicalFieldVectorQuery,
): string {
  const path = DATA_FIELD_VECTOR_PATH.replace(
    "{quantity_id}",
    encodeURIComponent(query.quantityId),
  );
  const params = canonicalFieldVectorQueryParams(query);
  const search = new URLSearchParams();
  for (const name of FIELD_VECTOR_QUERY_ORDER) {
    const value = params[name];
    if (value !== undefined) search.set(name, value);
  }
  const serialized = search.toString();
  return serialized ? `${path}?${serialized}` : path;
}

export function fieldVectorResourceKey(
  quantityId: string,
  query: FieldVectorQuery = {},
): string {
  return serializeCanonicalFieldVectorResourceKey(
    canonicalFieldVectorQuery(quantityId, query),
  );
}

export function parseCanonicalFieldVectorResourceKey(
  value: string,
): CanonicalFieldVectorQuery | null {
  let url: URL;
  try {
    url = new URL(value, "http://fullmag.invalid");
  } catch {
    return null;
  }

  const pathPrefix = DATA_FIELD_VECTOR_PATH.split("{quantity_id}");
  const prefix = pathPrefix[0];
  const suffix = pathPrefix[1];
  if (!prefix || suffix === undefined || !url.pathname.startsWith(prefix)) {
    return null;
  }
  const quantityEncoded = url.pathname.slice(prefix.length, url.pathname.length - suffix.length);
  if (!quantityEncoded || !url.pathname.endsWith(suffix)) return null;

  let quantityId: string;
  try {
    quantityId = decodeURIComponent(quantityEncoded);
  } catch {
    return null;
  }

  const maxSamples = url.searchParams.get("max_samples");
  const phaseRad = url.searchParams.get("phase_rad");
  return canonicalFieldVectorQuery(quantityId, {
    component: url.searchParams.get("component") ?? undefined,
    geometry_scope: url.searchParams.get("geometry_scope") ?? undefined,
    max_samples:
      maxSamples === null || maxSamples.length === 0 ? undefined : Number(maxSamples),
    owner_object_id: url.searchParams.get("owner_object_id") ?? undefined,
    phase_rad:
      phaseRad === null || phaseRad.length === 0 ? undefined : Number(phaseRad),
    scope_id: url.searchParams.get("scope_id") ?? undefined,
    scope_kind: url.searchParams.get("scope_kind") ?? undefined,
    snapshot_id: url.searchParams.get("snapshot_id") ?? undefined,
    stage_id: url.searchParams.get("stage_id") ?? undefined,
    view: url.searchParams.get("view") ?? undefined,
  });
}

const PLANAR_FIELD_QUERY_ORDER = [
  "sample_token",
  "component",
  "expected_carrier_revision",
  "expected_field_revision",
  "expected_mesh_revision",
  "expected_monitor_revision",
  "expected_scene_revision",
  "include_mesh",
  "quality",
  "resolution_x",
  "resolution_y",
  "scope_id",
  "scope_kind",
  "snapshot_id",
  "stage_id",
  "vector_budget",
] as const satisfies readonly (keyof PlanarFieldQuery)[];

const U64_MAX_DECIMAL = "18446744073709551615";

export function isCanonicalU64Decimal(value: string): boolean {
  if (value === "0") return true;
  if (!/^[1-9][0-9]*$/.test(value)) return false;
  if (value.length !== U64_MAX_DECIMAL.length) {
    return value.length < U64_MAX_DECIMAL.length;
  }
  return value <= U64_MAX_DECIMAL;
}

export function normalizePlanarFieldQuery(
  query: PlanarFieldQuery = {},
): PlanarFieldQuery {
  const normalized: PlanarFieldQuery = {
    include_mesh: query.include_mesh ?? false,
    quality: query.quality ?? "interactive",
    resolution_x: query.resolution_x ?? 128,
    resolution_y: query.resolution_y ?? 128,
    scope_kind: query.scope_kind ?? "monitor_target",
    vector_budget: query.vector_budget ?? 0,
  };
  for (const key of PLANAR_FIELD_QUERY_ORDER) {
    const value = query[key];
    if (value !== undefined && value !== null && value !== "") {
      Object.assign(normalized, { [key]: value });
    }
  }
  return normalized;
}

export function planarFieldResourcePath(
  quantityId: string,
  monitorId: string,
  path: string = DATA_PLANAR_FIELD_META_PATH,
): string {
  return path
    .replace("{quantity_id}", encodeURIComponent(quantityId))
    .replace("{monitor_id}", encodeURIComponent(monitorId));
}

export function planarFieldResourceKey(
  quantityId: string,
  monitorId: string,
  query: PlanarFieldQuery = {},
  path: string = DATA_PLANAR_FIELD_META_PATH,
): string {
  const resolvedPath = planarFieldResourcePath(quantityId, monitorId, path);
  const search = new URLSearchParams();
  const normalized = normalizePlanarFieldQuery(query);
  for (const key of PLANAR_FIELD_QUERY_ORDER) {
    const value = normalized[key];
    if (value !== undefined) search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `${resolvedPath}?${serialized}` : resolvedPath;
}
