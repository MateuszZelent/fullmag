import type { FdmMultilayerFieldVectorQuery } from "@/kernel/api/apiTypes";
import type { DecodedFieldVector } from "@/kernel/api/codecs";

import type { FdmMultilayerAirboxRenderDomain } from "../viewport3dDomainAdapter";
import { safeViewport3DDomainGenerationId } from "./viewport3DFieldDomainCompatibility";
import type { Viewport3DFieldResourceRequest } from "./viewport3DFieldDataPlan";

const FDM_MULTILAYER_AIRBOX_SCOPE_ID = "airbox";
const FDM_MULTILAYER_AIRBOX_QUANTITY_ID = "H_demag";

/**
 * The target-only Airbox has exactly one currently published observable.  It
 * must remain a distinct scoped resource rather than falling back to the FDM
 * common transform grid or the single-grid inactive-cell Airbox.
 */
export function buildFdmMultilayerAirboxFieldRequest(
  _domain: FdmMultilayerAirboxRenderDomain,
  maxSamples?: number | null,
): Viewport3DFieldResourceRequest {
  const query: FdmMultilayerFieldVectorQuery = {
    component: "full",
    scope_id: FDM_MULTILAYER_AIRBOX_SCOPE_ID,
    scope_kind: "airbox",
  };
  const normalizedMaxSamples = normalizeSampleLimit(maxSamples);
  if (normalizedMaxSamples !== null) {
    query.max_samples = normalizedMaxSamples;
  }
  return {
    consumers: ["viewport-3d:fdm-multilayer-airbox"],
    quantityId: FDM_MULTILAYER_AIRBOX_QUANTITY_ID,
    query,
    requestId: `fdm-multilayer-airbox:H_demag${
      normalizedMaxSamples === null ? "" : `:max_samples=${normalizedMaxSamples}`
    }`,
  };
}

export function shouldRequestFdmMultilayerAirboxField(
  settings: Pick<
    import("@/kernel/visualization/ObjectVisualizationController").VisualizationTargetSettings,
    "activeQuantityId" | "shaderVisible" | "vectorsVisible" | "visible"
  >,
): boolean {
  return (
    settings.visible &&
    (settings.shaderVisible || settings.vectorsVisible) &&
    settings.activeQuantityId === FDM_MULTILAYER_AIRBOX_QUANTITY_ID
  );
}

export function resolveFdmMultilayerAirboxFieldVector(
  domain: Pick<
    FdmMultilayerAirboxRenderDomain,
    "carrierFingerprint" | "domainGenerationId" | "shape" | "totalCells"
  >,
  fieldVector: DecodedFieldVector | null | undefined,
): DecodedFieldVector | null {
  if (!fieldVector) return null;
  const fieldGenerationId = safeNonEmptyDomainGenerationId(
    fieldVector.domainGenerationId,
  );
  const domainGenerationId = safeNonEmptyDomainGenerationId(
    domain.domainGenerationId,
  );
  const sampledGrid =
    fieldVector.indexing === "sampled_node_indices" &&
    fieldVector.grid[0] === fieldVector.pointCount &&
    fieldVector.grid[1] === 1 &&
    fieldVector.grid[2] === 1;
  if (
    fieldVector.formatVersion !== 3 ||
    fieldVector.quantityId !== FDM_MULTILAYER_AIRBOX_QUANTITY_ID ||
    fieldVector.scopeKind !== "airbox" ||
    fieldVector.scopeId !== FDM_MULTILAYER_AIRBOX_SCOPE_ID ||
    fieldGenerationId === null ||
    domainGenerationId === null ||
    fieldGenerationId !== domainGenerationId ||
    canonicalFingerprint(fieldVector.meshTopologyHash) !==
      canonicalFingerprint(domain.carrierFingerprint) ||
    (!sampledGrid &&
      fieldVector.grid.some((value, axis) => value !== domain.shape[axis])) ||
    fieldVector.pointCount <= 0 ||
    fieldVector.pointCount > domain.totalCells ||
    fieldVector.nComp !== 3 ||
    fieldVector.valueCount !== fieldVector.pointCount * 3 ||
    fieldVector.values.length !== fieldVector.valueCount ||
    !hasValidExplicitCellIndices(fieldVector, domain.totalCells)
  ) {
    return null;
  }
  return fieldVector;
}

function safeNonEmptyDomainGenerationId(value: unknown): string | null {
  const generationId = safeViewport3DDomainGenerationId(value);
  if (!generationId || generationId.trim() !== generationId) return null;
  return generationId;
}

function canonicalFingerprint(value: string | null | undefined): string | null {
  const matched = /^(?:sha256:)?([0-9a-f]{64})$/i.exec(value ?? "");
  return matched?.[1]?.toLowerCase() ?? null;
}

function hasValidExplicitCellIndices(
  fieldVector: DecodedFieldVector,
  totalCells: number,
): boolean {
  if (
    (fieldVector.indexing !== "explicit_node_indices" &&
      fieldVector.indexing !== "sampled_node_indices") ||
    !fieldVector.nodeIndices ||
    fieldVector.nodeIndices.length !== fieldVector.pointCount
  ) {
    return false;
  }
  const seen = new Uint8Array(Math.max(0, Math.floor(totalCells)));
  for (const index of fieldVector.nodeIndices) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= totalCells || seen[index]) {
      return false;
    }
    seen[index] = 1;
  }
  return true;
}

function normalizeSampleLimit(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}
