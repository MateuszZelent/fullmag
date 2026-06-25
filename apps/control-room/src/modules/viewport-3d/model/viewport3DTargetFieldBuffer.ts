import type { FieldVectorQuery } from "@/kernel/api/apiTypes";
import type { DecodedFieldVector } from "@/kernel/api/codecs";
import { resolveCanonicalQuantityId } from "@/kernel/api/quantityIds";

import type {
  Viewport3DFieldComponentDemand,
  Viewport3DFieldScopeKind,
} from "./viewport3DFieldDataPlan";

export type Viewport3DFieldPayloadCapability =
  | "full-vector-complete"
  | "full-vector-sampled"
  | "scalar-complete"
  | "synthetic-full-vector";

export interface Viewport3DTargetFieldBuffer {
  bufferId: string;
  capability: Viewport3DFieldPayloadCapability;
  component: Exclude<Viewport3DFieldComponentDemand, "none">;
  complete: boolean;
  fieldRevision: string | null;
  fieldVector: DecodedFieldVector;
  pointCount: number;
  quantityId: string;
  sampled: boolean;
  scopeId: string | null;
  scopeKind: Viewport3DFieldScopeKind;
  targetIds: readonly string[];
  topologyRevision: string | null;
  vectorComponentCount: number;
}

export function buildViewport3DTargetFieldBuffer({
  fieldRevision = null,
  fieldVector,
  query,
  synthetic = false,
  targetIds,
  topologyRevision = null,
}: {
  fieldRevision?: string | null;
  fieldVector: DecodedFieldVector;
  query: FieldVectorQuery;
  synthetic?: boolean;
  targetIds: readonly string[];
  topologyRevision?: string | null;
}): Viewport3DTargetFieldBuffer {
  const component = resolveTargetFieldBufferComponent(fieldVector, query);
  const sampled = query.max_samples != null;
  const capability = resolveTargetFieldBufferCapability({
    component,
    fieldVector,
    sampled,
    synthetic,
  });
  return {
    bufferId: buildViewport3DTargetFieldBufferId({
      component,
      fieldRevision,
      quantityId: fieldVector.quantityId,
      scopeId: query.scope_id ?? null,
      scopeKind: resolveTargetFieldBufferScopeKind(query.scope_kind),
      targetIds,
      topologyRevision,
    }),
    capability,
    component,
    complete: capability !== "full-vector-sampled",
    fieldRevision,
    fieldVector,
    pointCount: fieldVector.pointCount,
    quantityId: resolveCanonicalQuantityId(fieldVector.quantityId),
    sampled,
    scopeId: query.scope_id ?? null,
    scopeKind: resolveTargetFieldBufferScopeKind(query.scope_kind),
    targetIds: [...targetIds].sort(),
    topologyRevision,
    vectorComponentCount: fieldVector.nComp,
  };
}

export function viewport3DTargetFieldBufferCanServeSurface(
  buffer: Viewport3DTargetFieldBuffer | null | undefined,
  colorMode: string | null | undefined,
): boolean {
  if (!buffer || !colorMode) return false;
  if (!buffer.complete) return false;
  if (colorMode === "orientation" || colorMode === "hsl_sphere") {
    return buffer.capability === "full-vector-complete";
  }
  if (colorMode === "monochrome") return false;
  return (
    buffer.capability === "scalar-complete" ||
    buffer.capability === "full-vector-complete"
  );
}

export function viewport3DTargetFieldBufferCanServeVectors(
  buffer: Viewport3DTargetFieldBuffer | null | undefined,
): boolean {
  return (
    buffer?.capability === "full-vector-complete" ||
    buffer?.capability === "full-vector-sampled" ||
    buffer?.capability === "synthetic-full-vector"
  );
}

function resolveTargetFieldBufferComponent(
  fieldVector: DecodedFieldVector,
  query: FieldVectorQuery,
): Exclude<Viewport3DFieldComponentDemand, "none"> {
  if (query.component === "x" || query.component === "y" || query.component === "z") {
    return query.component;
  }
  if (query.component === "magnitude") return "magnitude";
  return fieldVector.nComp >= 3 ? "full" : "magnitude";
}

function resolveTargetFieldBufferCapability({
  component,
  fieldVector,
  sampled,
  synthetic,
}: {
  component: Exclude<Viewport3DFieldComponentDemand, "none">;
  fieldVector: DecodedFieldVector;
  sampled: boolean;
  synthetic: boolean;
}): Viewport3DFieldPayloadCapability {
  if (synthetic) return "synthetic-full-vector";
  if (component !== "full" || fieldVector.nComp < 3) return "scalar-complete";
  return sampled ? "full-vector-sampled" : "full-vector-complete";
}

function resolveTargetFieldBufferScopeKind(
  scopeKind: FieldVectorQuery["scope_kind"],
): Viewport3DFieldScopeKind {
  if (
    scopeKind === "airbox" ||
    scopeKind === "object" ||
    scopeKind === "part" ||
    scopeKind === "selection"
  ) {
    return scopeKind;
  }
  return "full";
}

function buildViewport3DTargetFieldBufferId({
  component,
  fieldRevision,
  quantityId,
  scopeId,
  scopeKind,
  targetIds,
  topologyRevision,
}: {
  component: Exclude<Viewport3DFieldComponentDemand, "none">;
  fieldRevision: string | null;
  quantityId: string;
  scopeId: string | null;
  scopeKind: Viewport3DFieldScopeKind;
  targetIds: readonly string[];
  topologyRevision: string | null;
}): string {
  return [
    resolveCanonicalQuantityId(quantityId),
    component,
    scopeKind,
    scopeId ?? "none",
    fieldRevision ?? "field:none",
    topologyRevision ?? "topology:none",
    [...targetIds].sort().join(","),
  ].join(":");
}
