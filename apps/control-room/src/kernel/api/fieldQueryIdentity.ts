import { DATA_FIELD_VECTOR_PATH } from "./apiPaths";
import type { FieldVectorQuery } from "./apiTypes";
import { resolveCanonicalQuantityId } from "./quantityIds";

export interface CanonicalFieldVectorQuery {
  readonly component: string;
  readonly componentExplicit: boolean;
  readonly geometryScope?: string;
  readonly maxSamples?: number;
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
  "phase_rad",
  "scope_id",
  "scope_kind",
  "snapshot_id",
  "stage_id",
  "view",
] as const;

function nonEmptyString(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
    phase_rad:
      phaseRad === null || phaseRad.length === 0 ? undefined : Number(phaseRad),
    scope_id: url.searchParams.get("scope_id") ?? undefined,
    scope_kind: url.searchParams.get("scope_kind") ?? undefined,
    snapshot_id: url.searchParams.get("snapshot_id") ?? undefined,
    stage_id: url.searchParams.get("stage_id") ?? undefined,
    view: url.searchParams.get("view") ?? undefined,
  });
}
