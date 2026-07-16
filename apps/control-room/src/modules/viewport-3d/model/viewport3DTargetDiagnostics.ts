import type { Viewport3DTargetRenderPassModel } from "../viewport3dRenderModel";

import type { Viewport3DDerivedWorkItem } from "./viewport3DDerivedWorkPlan";

export interface Viewport3DTargetDiagnosticSummary {
  buffers: readonly string[];
  degradation: readonly string[];
  demand: string | null;
  derivedWork: readonly string[];
  passes: readonly string[];
  requests: readonly string[];
  retained: readonly string[];
  targetId: string;
}

export function summarizeViewport3DTargetDiagnostics({
  derivedWorkItems,
  targetPasses,
}: {
  derivedWorkItems: readonly Viewport3DDerivedWorkItem[];
  targetPasses: ReadonlyMap<string, Viewport3DTargetRenderPassModel>;
}): Viewport3DTargetDiagnosticSummary[] {
  const workItemsByTarget = new Map<string, Viewport3DDerivedWorkItem[]>();
  for (const item of derivedWorkItems) {
    const items = workItemsByTarget.get(item.targetId);
    if (items) {
      items.push(item);
    } else {
      workItemsByTarget.set(item.targetId, [item]);
    }
  }

  return Array.from(targetPasses, ([targetId, pass]) => {
    const targetWorkItems = (workItemsByTarget.get(targetId) ?? []).toSorted(
      compareDerivedWorkItems,
    );
    return {
      buffers: summarizeTargetBuffers(pass),
      degradation: summarizeTargetDegradation(pass, targetWorkItems),
      demand: summarizeTargetDemand(pass),
      derivedWork: targetWorkItems.map(summarizeDerivedWorkItem),
      passes: summarizeTargetPasses(pass),
      requests: summarizeTargetRequests(pass),
      retained: summarizeTargetRetainedOutputs(pass),
      targetId,
    };
  }).toSorted((left, right) => left.targetId.localeCompare(right.targetId));
}

export function resolveViewport3DTargetDiagnosticResourceKeys(
  pass: Viewport3DTargetRenderPassModel,
): readonly string[] {
  return pass.fieldBuffer?.resourceKey ? [pass.fieldBuffer.resourceKey] : [];
}

function summarizeTargetPasses(
  pass: Viewport3DTargetRenderPassModel,
): string[] {
  const passes: string[] = [];
  if (pass.surface.scalarColorMode) passes.push("surface");
  if (
    pass.vectors.buildReference ||
    pass.vectors.segments ||
    pass.vectors.degradation
  ) {
    passes.push("vector-glyph");
  }
  return passes;
}

function summarizeTargetDemand(
  pass: Viewport3DTargetRenderPassModel,
): string | null {
  const demand: string[] = [];
  if (pass.surface.scalarColorMode) {
    demand.push(`surface:${pass.surface.scalarColorMode}`);
  }
  if (
    pass.vectors.buildReference ||
    pass.vectors.segments ||
    pass.vectors.degradation
  ) {
    demand.push("vector-glyph");
  }
  return demand.length > 0 ? demand.join(" ") : null;
}

function summarizeTargetRequests(
  pass: Viewport3DTargetRenderPassModel,
): string[] {
  return pass.fieldBuffer?.requestId ? [pass.fieldBuffer.requestId] : [];
}

function summarizeTargetBuffers(
  pass: Viewport3DTargetRenderPassModel,
): string[] {
  if (!pass.fieldBuffer) return [`state=${pass.fieldBufferState}`];
  const scopeId = pass.fieldBuffer.scopeId ?? "none";
  return [
    [
      pass.fieldBuffer.bufferId,
      pass.fieldBuffer.capability,
      `quantity=${pass.fieldBuffer.quantityId}`,
      `component=${pass.fieldBuffer.component}`,
      `scope=${pass.fieldBuffer.scopeKind}:${scopeId}`,
      `points=${pass.fieldBuffer.pointCount}`,
      `ncomp=${pass.fieldBuffer.vectorComponentCount}`,
      `indexing=${pass.fieldBuffer.indexing ?? "unknown"}`,
      `nodeIndices=${pass.fieldBuffer.nodeIndexCount ?? "none"}`,
      `topologyHash=${pass.fieldBuffer.meshTopologyHash ?? "none"}`,
      `sampled=${pass.fieldBuffer.sampled}`,
      `state=${pass.fieldBufferState}`,
    ].join(" "),
  ];
}

function summarizeTargetDegradation(
  pass: Viewport3DTargetRenderPassModel,
  workItems: readonly Viewport3DDerivedWorkItem[],
): string[] {
  const degradation = new Set<string>();
  if (pass.surface.degradation) {
    degradation.add(`surface:${pass.surface.degradation}`);
    if (pass.fieldBuffer) {
      degradation.add(
        [
          "surface-rejected",
          `buffer=${pass.fieldBuffer.bufferId}`,
          `capability=${pass.fieldBuffer.capability}`,
          `reason=${pass.surface.degradation}`,
        ].join(" "),
      );
    }
  }
  if (
    pass.surface.projectionMode &&
    pass.surface.projectionMode !== "raw_nodal" &&
    !surfaceProjectionSatisfied(pass)
  ) {
    degradation.add(
      `surface:projection-fallback mode=${pass.surface.projectionMode} fallback=raw_nodal`,
    );
  }
  const projectionSummary = summarizeSurfaceProjection(pass);
  if (projectionSummary) {
    degradation.add(projectionSummary);
  }
  const lowNormSummary = summarizeSurfaceLowNormOrientation(pass);
  if (lowNormSummary) {
    degradation.add(lowNormSummary);
  }
  const missingProjectionSummary = summarizeSurfaceMissingProjectedBins(pass);
  if (missingProjectionSummary) {
    degradation.add(missingProjectionSummary);
  }
  const projectionSuitabilitySummary = summarizeSurfaceProjectionSuitability(pass);
  if (projectionSuitabilitySummary) {
    degradation.add(projectionSuitabilitySummary);
  }
  if (pass.surface.scalarColors?.rangeDiagnostics?.outlierDominated) {
    const diagnostics = pass.surface.scalarColors.rangeDiagnostics;
    degradation.add(
      [
        "surface:range-outlier-dominated",
        `min=${diagnostics.min}`,
        `max=${diagnostics.max}`,
        `p01=${diagnostics.p01}`,
        `p99=${diagnostics.p99}`,
        `finite=${diagnostics.finiteCount}`,
        `nonFinite=${diagnostics.nonFiniteCount}`,
        `zero=${diagnostics.zeroCount}`,
      ].join(" "),
    );
  }
  if (pass.vectors.degradation) {
    degradation.add(`vector-glyph:${pass.vectors.degradation}`);
    if (pass.fieldBuffer) {
      degradation.add(
        [
          "vector-glyph-rejected",
          `buffer=${pass.fieldBuffer.bufferId}`,
          `capability=${pass.fieldBuffer.capability}`,
          `reason=${pass.vectors.degradation}`,
        ].join(" "),
      );
    }
  }
  for (const item of workItems) {
    if (item.blockedReason) {
      degradation.add(`${item.lane}:${item.blockedReason}`);
    }
  }
  return Array.from(degradation);
}

function summarizeSurfaceProjection(
  pass: Viewport3DTargetRenderPassModel,
): string | null {
  const buffer = pass.surface.scalarColors;
  if (!buffer?.projectionMode || buffer.projectionMode === "raw_nodal") {
    return null;
  }
  return [
    "surface:projection",
    `mode=${buffer.projectionMode}`,
    `geometry=${buffer.geometryRole ?? "unknown"}`,
    `rangeSource=${buffer.rangeSource ?? "unknown"}`,
    `faces=${buffer.faceCount ?? "unknown"}`,
    `degraded=${buffer.degradedFaceCount ?? "unknown"}`,
    `missingNodes=${buffer.missingNodeCount ?? "unknown"}`,
    `lowNorm=${buffer.lowNormFaceCount ?? 0}`,
    ...(buffer.projectionAxis ? [`axis=${buffer.projectionAxis}`] : []),
    ...(buffer.projectionTolerance !== undefined
      ? [`tolerance=${buffer.projectionTolerance}`]
      : []),
    ...(buffer.projectedBinCount !== undefined
      ? [`bins=${buffer.projectedBinCount}`]
      : []),
    ...(buffer.projectedSamplesPerBinMin !== undefined &&
    buffer.projectedSamplesPerBinMean !== undefined &&
    buffer.projectedSamplesPerBinMax !== undefined
      ? [
          `samplesPerBin=${buffer.projectedSamplesPerBinMin}/${buffer.projectedSamplesPerBinMean}/${buffer.projectedSamplesPerBinMax}`,
        ]
      : []),
  ].join(" ");
}

function summarizeSurfaceLowNormOrientation(
  pass: Viewport3DTargetRenderPassModel,
): string | null {
  const buffer = pass.surface.scalarColors;
  if (
    !buffer ||
    pass.surface.scalarColorMode !== "orientation" ||
    (buffer.lowNormFaceCount ?? 0) <= 0
  ) {
    return null;
  }
  return `surface:low-norm-orientation faces=${buffer.lowNormFaceCount}/${buffer.faceCount ?? "unknown"}`;
}

function summarizeSurfaceMissingProjectedBins(
  pass: Viewport3DTargetRenderPassModel,
): string | null {
  const buffer = pass.surface.scalarColors;
  if (
    !buffer ||
    buffer.projectionMode !== "thickness_average_z" ||
    (buffer.degradedFaceCount ?? 0) <= 0 ||
    (buffer.missingNodeCount ?? 0) <= 0
  ) {
    return null;
  }
  return `surface:missing-projected-bins faces=${buffer.degradedFaceCount}/${buffer.faceCount ?? "unknown"} missingNodes=${buffer.missingNodeCount}`;
}

function summarizeSurfaceProjectionSuitability(
  pass: Viewport3DTargetRenderPassModel,
): string | null {
  const suitability = pass.surface.scalarColors?.projectionSuitability;
  if (!suitability || suitability === "world_z_thin_film") {
    return null;
  }
  return `surface:projection-suitability state=${suitability}`;
}

function surfaceProjectionSatisfied(
  pass: Viewport3DTargetRenderPassModel,
): boolean {
  const scalarColors = pass.surface.scalarColors;
  if (!scalarColors) return false;
  return (
    pass.surface.projectionMode !== "raw_nodal" &&
    scalarColors.projectionMode === pass.surface.projectionMode &&
    scalarColors.geometryRole === "face_expanded_surface"
  );
}

function summarizeTargetRetainedOutputs(
  pass: Viewport3DTargetRenderPassModel,
): string[] {
  const retained: string[] = [];
  const currentFieldRevision = pass.fieldBuffer?.fieldRevision ?? null;
  if (!currentFieldRevision) return retained;

  const surfaceRevision = pass.surface.scalarColors?.targetRevision ?? null;
  if (
    surfaceRevision &&
    surfaceRevision !== `field=${currentFieldRevision}` &&
    surfaceRevision !== currentFieldRevision
  ) {
    retained.push(
      [
        "surface stale-compatible",
        `current=${currentFieldRevision}`,
        `retained=${surfaceRevision}`,
      ].join(" "),
    );
  }

  const vectorRevision = pass.vectors.buildReference?.fieldRevision ?? null;
  if (vectorRevision && vectorRevision !== currentFieldRevision) {
    retained.push(
      [
        "vector-glyph stale-compatible",
        `current=${currentFieldRevision}`,
        `retained=${vectorRevision}`,
      ].join(" "),
    );
  }

  return retained;
}

function summarizeDerivedWorkItem(item: Viewport3DDerivedWorkItem): string {
  const base = [
    item.lane,
    item.outputKind,
    item.status,
    item.execution,
    item.passId,
  ].join(":");
  return [
    base,
    `items=${item.itemCount}`,
    `input=${formatByteCount(item.inputBytes)}`,
    `output=${formatByteCount(item.outputBytesEstimate)}`,
  ].join(" ");
}

function formatByteCount(value: number): string {
  return `${Math.max(0, Math.floor(value))}B`;
}

function compareDerivedWorkItems(
  left: Viewport3DDerivedWorkItem,
  right: Viewport3DDerivedWorkItem,
): number {
  const passOrder = left.passId.localeCompare(right.passId);
  if (passOrder !== 0) return passOrder;
  return left.workId.localeCompare(right.workId);
}
