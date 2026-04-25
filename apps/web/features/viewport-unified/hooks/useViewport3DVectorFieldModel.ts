"use client";

import { useMemo } from "react";

import { useFieldVector } from "@/src/hooks/resources/useFieldVector";
import type { FieldComponent } from "@/src/api/types";
import type { DecodedFieldVector } from "@/src/api/codecs/types";
import type { LiveApiError } from "@/src/api/client/errors/LiveApiError";
import type {
  Viewport3DComponent,
  Viewport3DVectorFieldModel,
  Viewport3DVectorScope,
} from "../model/viewport3dContracts";
import { EMPTY_VIEWPORT3D_VECTOR_FIELD } from "../model/viewport3dContracts";

const FULL_VECTOR_SCOPE: Viewport3DVectorScope = { kind: "full" };

export interface UseViewport3DVectorFieldModelInput {
  quantityId: string | null;
  fieldRevision: number | null;
  domainGenerationId: number | null;
  positions?: Float32Array | Float64Array | null;
  adapterPointCount?: number | null;
  colorComponent: Viewport3DComponent;
  vectorsVisible: boolean;
  vectorCapabilityEnabled: boolean;
  unsupportedReason?: string | null;
  quantityComponentCount?: number | null;
  everyN: number;
  maxGlyphs?: number | null;
  scope?: Viewport3DVectorScope;
}

export interface BuildViewport3DVectorFieldModelInput
  extends UseViewport3DVectorFieldModelInput {
  field: DecodedFieldVector | null;
  loading: boolean;
  error: LiveApiError | Error | null;
}

export function useViewport3DVectorFieldModel({
  quantityId,
  fieldRevision,
  domainGenerationId,
  positions = null,
  adapterPointCount = null,
  colorComponent,
  vectorsVisible,
  vectorCapabilityEnabled,
  unsupportedReason = null,
  quantityComponentCount = null,
  everyN,
  maxGlyphs = null,
  scope = FULL_VECTOR_SCOPE,
}: UseViewport3DVectorFieldModelInput): Viewport3DVectorFieldModel {
  const directionComponent: FieldComponent = "full";
  const hasVectorQuantity = quantityComponentCount == null || quantityComponentCount >= 3;
  const shouldFetch =
    vectorsVisible &&
    vectorCapabilityEnabled &&
    hasVectorQuantity &&
    quantityId != null &&
    fieldRevision != null &&
    domainGenerationId != null;

  const { field, loading, error } = useFieldVector(
    shouldFetch ? quantityId : null,
    shouldFetch ? fieldRevision : null,
    {
      component: directionComponent,
      domainGenerationId: domainGenerationId ?? undefined,
      scopeKind: scope.kind,
      scopeId: scope.id ?? null,
    },
  );

  return useMemo(() => buildViewport3DVectorFieldModel({
    quantityId,
    fieldRevision,
    domainGenerationId,
    positions,
    adapterPointCount,
    colorComponent,
    vectorsVisible,
    vectorCapabilityEnabled,
    unsupportedReason,
    quantityComponentCount,
    everyN,
    maxGlyphs,
    scope,
    field,
    loading,
    error,
  }), [
    adapterPointCount,
    colorComponent,
    domainGenerationId,
    error,
    everyN,
    field,
    fieldRevision,
    loading,
    maxGlyphs,
    positions,
    quantityComponentCount,
    quantityId,
    scope,
    unsupportedReason,
    vectorCapabilityEnabled,
    vectorsVisible,
  ]);
}

export function buildViewport3DVectorFieldModel({
  quantityId,
  fieldRevision,
  domainGenerationId,
  positions = null,
  adapterPointCount = null,
  colorComponent,
  vectorsVisible,
  vectorCapabilityEnabled,
  unsupportedReason = null,
  quantityComponentCount = null,
  everyN,
  maxGlyphs = null,
  scope = FULL_VECTOR_SCOPE,
  field,
  loading,
  error,
}: BuildViewport3DVectorFieldModelInput): Viewport3DVectorFieldModel {
  const directionComponent: FieldComponent = "full";
  const hasVectorQuantity = quantityComponentCount == null || quantityComponentCount >= 3;
  const expectedPointCount =
    adapterPointCount ?? (positions ? positions.length / 3 : 0);
  const base = {
    ...EMPTY_VIEWPORT3D_VECTOR_FIELD,
    visible: vectorsVisible,
    quantityId,
    fieldRevision,
    domainGenerationId,
    directionComponent,
    colorComponent,
    scope,
    positions,
    adapterPointCount: expectedPointCount,
  };

  if (!vectorsVisible) {
    return { ...base, status: "idle" };
  }
  if (!vectorCapabilityEnabled) {
    return {
      ...base,
      status: "unsupported",
      error: unsupportedReason ?? "Requires vector field capability.",
    };
  }
  if (!hasVectorQuantity) {
    return {
      ...base,
      status: "unsupported",
      error: "Selected quantity is scalar; 3D vectors require at least 3 components.",
    };
  }
  if (loading) {
    return { ...base, status: "loading" };
  }
  if (error) {
    return { ...base, status: "error", error: error.message };
  }
  if (!field) {
    return { ...base, status: "idle" };
  }
  if (field.nComp < 3) {
    return {
      ...base,
      status: "unsupported",
      data: field,
      pointCount: field.pointCount,
      error: "Vector glyphs require a full vector payload with at least 3 components.",
    };
  }
  if (expectedPointCount > 0 && field.pointCount !== expectedPointCount) {
    return {
      ...base,
      status: "mismatch",
      data: field,
      pointCount: field.pointCount,
      error: `field.pointCount=${field.pointCount} != adapterPointCount=${expectedPointCount}`,
    };
  }

  const stride = Math.max(1, Math.trunc(everyN) || 1);
  const rawSampledCount = Math.ceil(field.pointCount / stride);
  const sampledCount =
    maxGlyphs != null && maxGlyphs > 0
      ? Math.min(rawSampledCount, Math.trunc(maxGlyphs))
      : rawSampledCount;

  return {
    ...base,
    status: "ready",
    data: field,
    pointCount: field.pointCount,
    sampledCount,
    error: null,
  };
}
