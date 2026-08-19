import type { FieldVectorQuery } from "@/kernel/api/apiTypes";
import type { DecodedFieldVector } from "@/kernel/api/codecs";
import {
  resolveCanonicalQuantityId,
  sameRenderableFieldQuantityId,
} from "@/kernel/api/quantityIds";
import type { SurfaceFieldProjectionMode } from "@/kernel/visualization/ObjectVisualizationController";

import type {
  Viewport3DFieldComponentDemand,
  Viewport3DFieldScopeKind,
} from "./viewport3DFieldDataPlan";
import { buildViewport3DFieldResourceRequestId } from "./viewport3DFieldDataPlan";
import {
  resolveViewport3DFieldDomainCompatibility,
  type Viewport3DFieldDomainCompatibility,
  type Viewport3DFieldDomainIdentity,
} from "./viewport3DFieldDomainCompatibility";

export type Viewport3DFieldPayloadCapability =
  | "full-vector-complete"
  | "full-vector-sampled"
  | "scalar-complete"
  | "synthetic-full-vector";

export interface Viewport3DTargetFieldBuffer {
  bufferId: string;
  capability: Viewport3DFieldPayloadCapability;
  component: Exclude<Viewport3DFieldComponentDemand, "none">;
  componentCount: number;
  currentDomainGenerationId: string | null;
  currentMeshTopologyHash: string | null;
  domainCompatibility: Viewport3DFieldDomainCompatibility;
  domainGenerationId: string | null;
  complete: boolean;
  consumers: readonly string[];
  fieldRevision: string | null;
  fieldVector: DecodedFieldVector;
  indexing: NonNullable<DecodedFieldVector["indexing"]>;
  meshTopologyHash: string | null;
  nodeIndices: DecodedFieldVector["nodeIndices"];
  pointCount: number;
  quantityId: string;
  requestId: string | null;
  requestIdentityCompatible: boolean;
  resourceKey: string | null;
  sampled: boolean;
  scopeId: string | null;
  scopeKind: Viewport3DFieldScopeKind;
  targetIds: readonly string[];
  topologyRevision: string | null;
  values: DecodedFieldVector["values"];
  vectorComponentCount: number;
}

export type Viewport3DTargetFieldInputSource =
  | "fallback-field-vector"
  | "legacy-part-field-vector"
  | "none"
  | "target-buffer";

export interface Viewport3DTargetFieldInput {
  explicitFieldBuffer: Viewport3DTargetFieldBuffer | null;
  explicitFieldVector: DecodedFieldVector | null;
  fieldVector: DecodedFieldVector | null;
  source: Viewport3DTargetFieldInputSource;
}

export function buildViewport3DTargetFieldBuffer({
  consumers = [],
  domain,
  fieldRevision = null,
  fieldVector,
  query,
  resourceKey,
  synthetic = false,
  targetIds,
  topologyRevision = null,
}: {
  consumers?: readonly string[];
  domain?: Viewport3DFieldDomainIdentity;
  fieldRevision?: string | null;
  fieldVector: DecodedFieldVector;
  query: FieldVectorQuery;
  resourceKey: string | null;
  synthetic?: boolean;
  targetIds: readonly string[];
  topologyRevision?: string | null;
}): Viewport3DTargetFieldBuffer {
  const component = resolveTargetFieldBufferComponent(fieldVector, query);
  const indexing = fieldVector.indexing ?? "legacy_count_only";
  const sampled = indexing === "sampled_node_indices" || query.max_samples != null;
  const meshTopologyHash = fieldVector.meshTopologyHash ?? null;
  const domainGenerationId = fieldVector.domainGenerationId ?? null;
  const requestedScopeKind = resolveTargetFieldBufferScopeKind(query.scope_kind);
  const requestedScopeId = canonicalTargetFieldBufferScopeId(
    requestedScopeKind,
    query.scope_id ?? null,
    query.owner_object_id ?? null,
  );
  const hasDecodedScopeIdentity = fieldVector.formatVersion === 3;
  const scopeKind = hasDecodedScopeIdentity
    ? resolveTargetFieldBufferScopeKind(fieldVector.scopeKind)
    : requestedScopeKind;
  const scopeId = hasDecodedScopeIdentity
    ? canonicalTargetFieldBufferScopeId(scopeKind, fieldVector.scopeId ?? null)
    : requestedScopeId;
  const requestIdentityCompatible = Boolean(
    synthetic ||
      !hasDecodedScopeIdentity ||
      (scopeKind === requestedScopeKind && scopeId === requestedScopeId),
  );
  const domainCompatibility = resolveViewport3DFieldDomainCompatibility({
    domain: domain ?? {
      domainGenerationId: null,
      meshTopologyHash: null,
      meshTopologyRevision: null,
      pointCount: 0,
    },
    field: fieldVector,
  });
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
      scopeId,
      scopeKind,
      targetIds,
      meshTopologyHash,
      domainGenerationId,
      indexing,
      topologyRevision,
    }),
    capability,
    component,
    componentCount: fieldVector.nComp,
    currentDomainGenerationId: domain?.domainGenerationId ?? null,
    currentMeshTopologyHash: domain?.meshTopologyHash ?? null,
    domainCompatibility,
    domainGenerationId,
    complete: capability !== "full-vector-sampled",
    consumers: [...consumers].sort(),
    fieldRevision,
    fieldVector,
    indexing,
    meshTopologyHash,
    nodeIndices: fieldVector.nodeIndices ?? null,
    pointCount: fieldVector.pointCount,
    quantityId: resolveCanonicalQuantityId(fieldVector.quantityId),
    requestId: synthetic
      ? null
      : buildViewport3DFieldResourceRequestId(fieldVector.quantityId, query),
    requestIdentityCompatible,
    resourceKey,
    sampled,
    scopeId,
    scopeKind,
    targetIds: [...targetIds].sort(),
    topologyRevision,
    values: fieldVector.values,
    vectorComponentCount: fieldVector.nComp,
  };
}

export function resolveViewport3DTargetFieldInput({
  fallbackFieldVector,
  legacyPartFieldVectors,
  partId,
  targetFieldBuffers,
}: {
  fallbackFieldVector: DecodedFieldVector | null | undefined;
  legacyPartFieldVectors?: ReadonlyMap<string, DecodedFieldVector>;
  partId: string;
  targetFieldBuffers?: ReadonlyMap<string, Viewport3DTargetFieldBuffer>;
}): Viewport3DTargetFieldInput {
  const explicitFieldBuffer = targetFieldBuffers?.get(partId) ?? null;
  if (explicitFieldBuffer) {
    return {
      explicitFieldBuffer,
      explicitFieldVector: explicitFieldBuffer.fieldVector,
      fieldVector: explicitFieldBuffer.fieldVector,
      source: "target-buffer",
    };
  }
  if (targetFieldBuffers) {
    return {
      explicitFieldBuffer: null,
      explicitFieldVector: null,
      fieldVector: null,
      source: "none",
    };
  }

  const legacyPartFieldVector = legacyPartFieldVectors?.get(partId) ?? null;
  if (legacyPartFieldVector) {
    return {
      explicitFieldBuffer: null,
      explicitFieldVector: legacyPartFieldVector,
      fieldVector: legacyPartFieldVector,
      source: "legacy-part-field-vector",
    };
  }

  return {
    explicitFieldBuffer: null,
    explicitFieldVector: null,
    fieldVector: fallbackFieldVector ?? null,
    source: fallbackFieldVector ? "fallback-field-vector" : "none",
  };
}

export function viewport3DTargetFieldBufferCanServeSurface(
  buffer: Viewport3DTargetFieldBuffer | null | undefined,
  colorMode: string | null | undefined,
  quantityId?: string | null,
  projectionMode: SurfaceFieldProjectionMode = "raw_nodal",
): boolean {
  if (!buffer || !colorMode) return false;
  if (!buffer.requestIdentityCompatible) return false;
  if (buffer.domainCompatibility.status === "mismatch") return false;
  if (!viewport3DTargetFieldBufferMatchesQuantity(buffer, quantityId)) {
    return false;
  }
  if (!buffer.complete && projectionMode === "raw_nodal") return false;
  if (!targetFieldBufferHasSurfaceCompatibleIndexing(buffer, projectionMode)) {
    return false;
  }
  const vectorSurfaceCapable =
    buffer.capability === "full-vector-complete" ||
    (projectionMode !== "raw_nodal" &&
      buffer.capability === "full-vector-sampled");
  if (colorMode === "orientation" || colorMode === "hsl_sphere") {
    return vectorSurfaceCapable;
  }
  if (colorMode === "monochrome") return false;
  const scalarComponent = scalarComponentForColorMode(colorMode);
  if (!scalarComponent) return buffer.capability === "full-vector-complete";
  if (buffer.capability === "scalar-complete") {
    return buffer.component === scalarComponent;
  }
  return (
    vectorSurfaceCapable
  );
}

export function viewport3DTargetFieldBufferCanServeVectors(
  buffer: Viewport3DTargetFieldBuffer | null | undefined,
  quantityId?: string | null,
): boolean {
  if (!buffer) return false;
  if (!buffer.requestIdentityCompatible) return false;
  if (buffer.domainCompatibility.status === "mismatch") return false;
  if (!viewport3DTargetFieldBufferMatchesQuantity(buffer, quantityId)) {
    return false;
  }
  if (!targetFieldBufferHasVectorCompatibleIndexing(buffer)) return false;
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

function targetFieldBufferHasSurfaceCompatibleIndexing(
  buffer: Viewport3DTargetFieldBuffer,
  projectionMode: SurfaceFieldProjectionMode,
): boolean {
  if (buffer.indexing === "sampled_node_indices") {
    return (
      projectionMode !== "raw_nodal" && targetFieldBufferHasNodeIndexMap(buffer)
    );
  }
  if (buffer.indexing === "explicit_node_indices") {
    return targetFieldBufferHasNodeIndexMap(buffer);
  }
  if (buffer.indexing === "full_domain") {
    return buffer.meshTopologyHash !== null;
  }
  return true;
}

function targetFieldBufferHasVectorCompatibleIndexing(
  buffer: Viewport3DTargetFieldBuffer,
): boolean {
  if (
    buffer.indexing === "explicit_node_indices" ||
    buffer.indexing === "sampled_node_indices"
  ) {
    return targetFieldBufferHasNodeIndexMap(buffer);
  }
  if (buffer.indexing === "full_domain") {
    return buffer.meshTopologyHash !== null;
  }
  return true;
}

function targetFieldBufferHasNodeIndexMap(
  buffer: Viewport3DTargetFieldBuffer,
): boolean {
  return (
    buffer.meshTopologyHash !== null &&
    buffer.nodeIndices != null &&
    buffer.nodeIndices.length === buffer.pointCount
  );
}

function resolveTargetFieldBufferScopeKind(
  scopeKind: FieldVectorQuery["scope_kind"],
): Viewport3DFieldScopeKind {
  if (
    scopeKind === "airbox" ||
    scopeKind === "layer" ||
    scopeKind === "object" ||
    scopeKind === "part" ||
    scopeKind === "region" ||
    scopeKind === "selection"
  ) {
    return scopeKind;
  }
  return "full";
}

function canonicalTargetFieldBufferScopeId(
  scopeKind: Viewport3DFieldScopeKind,
  scopeId: string | null,
  ownerObjectId: string | null = null,
): string | null {
  if (scopeId && scopeKind === "region" && ownerObjectId) {
    const canonicalPrefix = `region:${ownerObjectId}:`;
    return scopeId.startsWith(canonicalPrefix)
      ? scopeId
      : `${canonicalPrefix}${scopeId}`;
  }
  if (!scopeId || scopeKind !== "object") return scopeId;
  return scopeId.startsWith("object:")
    ? scopeId.slice("object:".length)
    : scopeId;
}

export function viewport3DTargetFieldBufferMatchesQuantity(
  buffer: Viewport3DTargetFieldBuffer | null | undefined,
  quantityId?: string | null,
): boolean {
  return (
    !buffer ||
    quantityId == null ||
    sameRenderableFieldQuantityId(buffer.quantityId, quantityId)
  );
}

function buildViewport3DTargetFieldBufferId({
  component,
  fieldRevision,
  quantityId,
  scopeId,
  scopeKind,
  targetIds,
  meshTopologyHash,
  domainGenerationId,
  indexing,
  topologyRevision,
}: {
  component: Exclude<Viewport3DFieldComponentDemand, "none">;
  fieldRevision: string | null;
  quantityId: string;
  scopeId: string | null;
  scopeKind: Viewport3DFieldScopeKind;
  targetIds: readonly string[];
  meshTopologyHash: string | null;
  domainGenerationId: string | null;
  indexing: NonNullable<DecodedFieldVector["indexing"]>;
  topologyRevision: string | null;
}): string {
  return [
    resolveCanonicalQuantityId(quantityId),
    component,
    scopeKind,
    scopeId ?? "none",
    fieldRevision ?? "field:none",
    domainGenerationId ?? "generation:none",
    topologyRevision ?? "topology:none",
    meshTopologyHash ?? "topology-hash:none",
    indexing,
    [...targetIds].sort().join(","),
  ].join(":");
}

function scalarComponentForColorMode(
  colorMode: string,
): "magnitude" | "x" | "y" | "z" | null {
  return colorMode === "magnitude" ||
    colorMode === "x" ||
    colorMode === "y" ||
    colorMode === "z"
    ? colorMode
    : null;
}
