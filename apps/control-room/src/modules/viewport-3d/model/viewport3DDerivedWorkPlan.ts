import type { DecodedComplexFieldVector } from "@/kernel/api/codecs";

import type {
  Viewport3DTargetPassDegradation,
  Viewport3DTargetRenderPassModel,
} from "../viewport3dRenderModel";

export type Viewport3DDerivedWorkLane =
  | "field-color"
  | "gpu-upload"
  | "vector-glyph";

export type Viewport3DDerivedWorkOutputKind =
  | "buffer-attribute"
  | "complex-phase-projection"
  | "scalar-colors"
  | "surface-face-colors"
  | "surface-thickness-projection"
  | "surface-vertex-colors"
  | "vector-glyphs"
  | "vector-segments";

export type Viewport3DDerivedWorkStatus = "blocked" | "ready";

export type Viewport3DDerivedWorkExecution =
  | "blocked"
  | "render-model-sync"
  | "runtime-worker";

export interface Viewport3DDerivedWorkItem {
  blockedReason: Viewport3DTargetPassDegradation | null;
  execution: Viewport3DDerivedWorkExecution;
  inputBufferId: string;
  inputBytes: number;
  itemCount: number;
  lane: Viewport3DDerivedWorkLane;
  latestWins: boolean;
  outputKind: Viewport3DDerivedWorkOutputKind;
  outputBytesEstimate: number;
  passId: string;
  staleCompatibilityKey: string;
  status: Viewport3DDerivedWorkStatus;
  targetId: string;
  workId: string;
}

export function planViewport3DDerivedWorkItems({
  complexFieldVector,
  targetPasses,
  visualizationPhaseRad,
}: {
  complexFieldVector?: DecodedComplexFieldVector | null;
  targetPasses: ReadonlyMap<string, Viewport3DTargetRenderPassModel>;
  visualizationPhaseRad?: number | null;
}): Viewport3DDerivedWorkItem[] {
  const items: Viewport3DDerivedWorkItem[] = [];
  const complexProjectionItem = buildComplexPhaseProjectionWorkItem({
    complexFieldVector,
    visualizationPhaseRad,
  });
  if (complexProjectionItem) {
    items.push(complexProjectionItem);
  }

  for (const [targetId, pass] of targetPasses) {
    if (pass.surface.scalarColorMode) {
      items.push(buildSurfaceColorWorkItem(targetId, pass));
    }
    if (
      pass.vectors.buildReference ||
      pass.vectors.degradation ||
      pass.vectors.segments
    ) {
      items.push(buildVectorSegmentWorkItem(targetId, pass));
      items.push(buildVectorGlyphWorkItem(targetId, pass));
    }
  }

  return items.sort((left, right) => left.workId.localeCompare(right.workId));
}

function buildComplexPhaseProjectionWorkItem({
  complexFieldVector,
  visualizationPhaseRad,
}: {
  complexFieldVector?: DecodedComplexFieldVector | null;
  visualizationPhaseRad?: number | null;
}): Viewport3DDerivedWorkItem | null {
  if (
    !complexFieldVector ||
    typeof visualizationPhaseRad !== "number" ||
    !Number.isFinite(visualizationPhaseRad)
  ) {
    return null;
  }
  const outputBytesEstimate =
    complexFieldVector.pointCount *
    complexFieldVector.componentCount *
    Float64Array.BYTES_PER_ELEMENT;
  const phaseRevision = `phase=${visualizationPhaseRad}`;
  return {
    blockedReason: null,
    execution: "runtime-worker",
    inputBufferId: `complex-field:${complexFieldVector.quantityId}`,
    inputBytes: typedArrayByteLength(complexFieldVector.values),
    itemCount: complexFieldVector.pointCount,
    lane: "field-color",
    latestWins: true,
    outputKind: "complex-phase-projection",
    outputBytesEstimate,
    passId: "complex-field:phase-projection",
    staleCompatibilityKey: [
      "complex-phase-projection",
      complexFieldVector.quantityId,
      complexFieldVector.pointCount,
      complexFieldVector.componentCount,
      phaseRevision,
    ].join(":"),
    status: "ready",
    targetId: "complex-field",
    workId: [
      "complex-phase-projection",
      complexFieldVector.quantityId,
      complexFieldVector.pointCount,
      complexFieldVector.componentCount,
      phaseRevision,
    ].join(":"),
  };
}

function buildSurfaceColorWorkItem(
  targetId: string,
  pass: Viewport3DTargetRenderPassModel,
): Viewport3DDerivedWorkItem {
  const colorMode = pass.surface.scalarColorMode ?? "none";
  const inputBufferId = resolveTargetPassInputBufferId(targetId, pass);
  const blockedReason = surfaceColorBlockedReason(pass.surface.degradation);
  const status: Viewport3DDerivedWorkStatus = blockedReason ? "blocked" : "ready";
  const projectionRevision = `projection=${pass.surface.projectionMode ?? "raw_nodal"}`;
  const staleCompatibilityKey = [
    "surface",
    targetId,
    colorMode,
    projectionRevision,
    inputBufferId,
    pass.surface.scalarColors?.colorPalette ?? "palette:pending",
    pass.surface.scalarColors?.range.min ?? "range:min:pending",
    pass.surface.scalarColors?.range.max ?? "range:max:pending",
    pass.surface.scalarColors?.quantityId ?? "quantity:pending",
    pass.surface.scalarColors?.targetRevision ?? "target:pending",
    pass.surface.scalarColors?.topologyRevision ?? "topology:pending",
  ].join(":");

  return {
    blockedReason,
    execution: blockedReason
      ? "blocked"
      : pass.surface.scalarColors
        ? "render-model-sync"
        : "runtime-worker",
    inputBufferId,
    inputBytes: scalarColorInputBytes(pass),
    itemCount: scalarColorItemCount(pass),
    lane: "field-color",
    latestWins: true,
    outputKind: surfaceColorOutputKind(pass),
    outputBytesEstimate: scalarColorOutputBytesEstimate(pass),
    passId: pass.surface.passId,
    staleCompatibilityKey,
    status,
    targetId,
    workId: [
      "field-color",
      pass.surface.passId,
      colorMode,
      projectionRevision,
      inputBufferId,
    ].join(":"),
  };
}

function surfaceColorOutputKind(
  pass: Viewport3DTargetRenderPassModel,
): Viewport3DDerivedWorkOutputKind {
  if (pass.surface.projectionMode === "surface_faces") {
    return "surface-face-colors";
  }
  if (pass.surface.projectionMode === "thickness_average_z") {
    return "surface-thickness-projection";
  }
  return "surface-vertex-colors";
}

function buildVectorSegmentWorkItem(
  targetId: string,
  pass: Viewport3DTargetRenderPassModel,
): Viewport3DDerivedWorkItem {
  const inputBufferId = resolveVectorInputBufferId(pass);
  const blockedReason = vectorSegmentBlockedReason(pass.vectors.degradation);
  const status: Viewport3DDerivedWorkStatus = blockedReason ? "blocked" : "ready";
  const staleCompatibilityKey = [
    "vector-segments",
    targetId,
    inputBufferId,
    pass.vectors.buildReference?.targetRevision ?? "target:pending",
    pass.vectors.buildReference?.topologyRevision ?? "topology:pending",
  ].join(":");

  return {
    blockedReason,
    execution: blockedReason ? "blocked" : "runtime-worker",
    inputBufferId,
    inputBytes: vectorSegmentInputBytes(pass),
    itemCount: blockedReason ? 0 : vectorSegmentItemCountEstimate(pass),
    lane: "vector-glyph",
    latestWins: true,
    outputKind: "vector-segments",
    outputBytesEstimate: blockedReason ? 0 : vectorSegmentOutputBytesEstimate(pass),
    passId: pass.vectors.passId,
    staleCompatibilityKey,
    status,
    targetId,
    workId: [
      "vector-segments",
      pass.vectors.passId,
      inputBufferId,
      status,
    ].join(":"),
  };
}

function vectorSegmentInputBytes(
  pass: Viewport3DTargetRenderPassModel,
): number {
  return typedArrayByteLength(pass.fieldBuffer?.values);
}

function vectorSegmentItemCountEstimate(
  pass: Viewport3DTargetRenderPassModel,
): number {
  return (
    vectorSegmentItemCount(pass.vectors.segments) ??
    pass.fieldBuffer?.pointCount ??
    0
  );
}

function vectorSegmentOutputBytesEstimate(
  pass: Viewport3DTargetRenderPassModel,
): number {
  return (
    typedArrayByteLength(pass.vectors.segments) ||
    (pass.fieldBuffer?.pointCount ?? 0) * 7 * Float32Array.BYTES_PER_ELEMENT
  );
}

function buildVectorGlyphWorkItem(
  targetId: string,
  pass: Viewport3DTargetRenderPassModel,
): Viewport3DDerivedWorkItem {
  const inputBufferId = resolveVectorInputBufferId(pass);
  const blockedReason = vectorGlyphBlockedReason(pass.vectors.degradation);
  const status: Viewport3DDerivedWorkStatus = blockedReason ? "blocked" : "ready";
  const staleCompatibilityKey = [
    "vector-glyph",
    targetId,
    inputBufferId,
    pass.vectors.buildReference?.targetRevision ?? "target:pending",
    pass.vectors.buildReference?.topologyRevision ?? "topology:pending",
  ].join(":");

  return {
    blockedReason,
    execution: blockedReason ? "blocked" : "runtime-worker",
    inputBufferId,
    inputBytes: typedArrayByteLength(pass.vectors.segments),
    itemCount: vectorSegmentItemCount(pass.vectors.segments) ?? 0,
    lane: "vector-glyph",
    latestWins: true,
    outputKind: "vector-glyphs",
    outputBytesEstimate: typedArrayByteLength(pass.vectors.segments),
    passId: pass.vectors.passId,
    staleCompatibilityKey,
    status,
    targetId,
    workId:
      pass.vectors.buildReference?.buildKey ??
      [
        "vector-glyph",
        pass.vectors.passId,
        inputBufferId,
        status,
      ].join(":"),
  };
}

function resolveVectorInputBufferId(
  pass: Viewport3DTargetRenderPassModel,
): string {
  return (
    pass.fieldBuffer?.bufferId ??
    pass.vectors.buildReference?.fieldRevision ??
    `field-buffer:${pass.fieldBufferState}`
  );
}

function resolveTargetPassInputBufferId(
  targetId: string,
  pass: Viewport3DTargetRenderPassModel,
): string {
  return pass.fieldBuffer?.bufferId ?? `${pass.fieldBufferState}:${targetId}`;
}

function scalarColorInputBytes(
  pass: Viewport3DTargetRenderPassModel,
): number {
  const scalarColors = pass.surface.scalarColors;
  if (!scalarColors) return 0;
  return (
    typedArrayByteLength(scalarColors.scalarValues) +
    typedArrayByteLength(scalarColors.vectorValues) +
    typedArrayByteLength(scalarColors.complexRealValues) +
    typedArrayByteLength(scalarColors.complexImagValues)
  );
}

function scalarColorItemCount(
  pass: Viewport3DTargetRenderPassModel,
): number {
  const scalarColors = pass.surface.scalarColors;
  if (!scalarColors) return 0;
  if (scalarColors.scalarValues) return scalarColors.scalarValues.length;
  if (scalarColors.vectorValues) {
    return Math.floor(scalarColors.vectorValues.length / 3);
  }
  if (scalarColors.complexRealValues || scalarColors.complexImagValues) {
    return Math.floor(
      Math.max(
        scalarColors.complexRealValues?.length ?? 0,
        scalarColors.complexImagValues?.length ?? 0,
      ) / 3,
    );
  }
  return Math.floor(scalarColors.colors.length / 3);
}

function scalarColorOutputBytesEstimate(
  pass: Viewport3DTargetRenderPassModel,
): number {
  return typedArrayByteLength(pass.surface.scalarColors?.colors);
}

function vectorSegmentItemCount(
  segments: Float32Array | null | undefined,
): number | null {
  return segments ? Math.floor(segments.length / 7) : null;
}

function typedArrayByteLength(
  value: ArrayBufferView | null | undefined,
): number {
  return value?.byteLength ?? 0;
}

function surfaceColorBlockedReason(
  degradation: Viewport3DTargetPassDegradation | null,
): Viewport3DTargetPassDegradation | null {
  return degradation === "buffer-not-surface-capable" ||
    degradation === "buffer-quantity-mismatch" ||
    degradation === "sampled-buffer-not-surface-capable"
    ? degradation
    : null;
}

function vectorGlyphBlockedReason(
  degradation: Viewport3DTargetPassDegradation | null,
): Viewport3DTargetPassDegradation | null {
  return degradation === "buffer-not-vector-capable" ||
    degradation === "buffer-quantity-mismatch" ||
    degradation === "scalar-buffer-not-vector-capable" ||
    degradation === "vector-segments-unavailable"
    ? degradation
    : null;
}

function vectorSegmentBlockedReason(
  degradation: Viewport3DTargetPassDegradation | null,
): Viewport3DTargetPassDegradation | null {
  return degradation === "buffer-not-vector-capable" ||
    degradation === "buffer-quantity-mismatch" ||
    degradation === "scalar-buffer-not-vector-capable"
    ? degradation
    : null;
}
