"use client";

import { useEffect, useMemo, useState } from "react";

import { incrementFrontendAuditCounter } from "@/lib/debug/frontendAudit";
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
  auditRole?: "glyph" | "shader";
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
  auditRole,
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
  useEffect(() => {
    if (!shouldFetch || !auditRole) {
      return;
    }
    incrementFrontendAuditCounter(
      auditRole === "glyph" ? "fieldVectorGlyphRequests" : "fieldVectorShaderRequests",
      1,
    );
  }, [auditRole, shouldFetch]);

  const { field, loading, error } = useFieldVector(
    shouldFetch ? quantityId : null,
    shouldFetch ? fieldRevision : null,
    {
      component: directionComponent,
      domainGenerationId: domainGenerationId ?? undefined,
      scopeKind: scope.kind,
      scopeId: scope.id ?? null,
      auditResource: auditRole ? `field-vector-${auditRole}` : undefined,
    },
  );

  const currentModel = useMemo(() => buildViewport3DVectorFieldModel({
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
  const [lastRenderableModel, setLastRenderableModel] =
    useState<Viewport3DVectorFieldModel | null>(null);

  useEffect(() => {
    if (isViewport3DVectorFieldRenderable(currentModel) && currentModel.status === "ready") {
      setLastRenderableModel(currentModel);
    }
  }, [currentModel]);

  return useMemo(
    () => retainRenderableViewport3DVectorFieldData(currentModel, lastRenderableModel),
    [currentModel, lastRenderableModel],
  );
}

export function isViewport3DVectorFieldRenderable(
  model: Viewport3DVectorFieldModel | null | undefined,
): model is Viewport3DVectorFieldModel & { data: DecodedFieldVector } {
  return Boolean(model?.visible && model.data && model.data.nComp >= 3 && model.data.values.length > 0);
}

function sameViewport3DVectorScope(
  a: Viewport3DVectorScope,
  b: Viewport3DVectorScope,
): boolean {
  return a.kind === b.kind && (a.id ?? null) === (b.id ?? null);
}

export function canReuseViewport3DVectorFieldModelData(
  current: Viewport3DVectorFieldModel,
  previous: Viewport3DVectorFieldModel | null | undefined,
): boolean {
  return Boolean(
    current.status === "loading" &&
      current.visible &&
      previous &&
      isViewport3DVectorFieldRenderable(previous) &&
      current.quantityId === previous.quantityId &&
      current.domainGenerationId === previous.domainGenerationId &&
      current.directionComponent === previous.directionComponent &&
      sameViewport3DVectorScope(current.scope, previous.scope) &&
      (current.adapterPointCount <= 0 || current.adapterPointCount === previous.pointCount),
  );
}

export function retainRenderableViewport3DVectorFieldData(
  current: Viewport3DVectorFieldModel,
  previous: Viewport3DVectorFieldModel | null | undefined,
): Viewport3DVectorFieldModel {
  if (!canReuseViewport3DVectorFieldModelData(current, previous) || !previous?.data) {
    return current;
  }
  return {
    ...current,
    data: previous.data,
    positions: previous.positions,
    pointCount: previous.pointCount,
    sampledCount: previous.sampledCount,
    error: null,
  };
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
