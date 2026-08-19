import type { DecodedComplexFieldVector } from "@/kernel/api/codecs";
import type { ModeCompositionLayer } from "@/kernel/visualization/ModeCompositionController";
import type {
  ModeCompositionFieldLayerSnapshot,
} from "@/kernel/visualization/ModeCompositionFieldLayerController";

import type { ScalarColorBuffer, ScalarRange } from "../viewport3dFieldMapping";
import {
  buildModeCompositionRenderPlan,
  type ConfiguredBaseSurface,
  type ModeCompositionModalResourceLifecycle,
  type ModeCompositionTargetRenderPlan,
} from "./modeCompositionRenderPlan";

export interface ModeCompositionViewportTargetDetail {
  readonly targetId: string;
  readonly targetKind: "object";
}

export interface ModeCompositionViewportModalBuffer {
  readonly field: DecodedComplexFieldVector;
  readonly identity: ModeCompositionFieldLayerSnapshot["identity"];
  readonly layer: ModeCompositionLayer;
}

export type ModeCompositionMeshPartRenderPlan<TBaseSurface> =
  ModeCompositionTargetRenderPlan<
    ModeCompositionViewportTargetDetail,
    TBaseSurface,
    ModeCompositionViewportModalBuffer
  >;

interface ComplexAttributeProjection {
  readonly imag: Float32Array;
  readonly maxAbsImag: readonly [number, number, number];
  readonly maxAbsMagnitude: readonly [number, number, number];
  readonly maxAbsReal: readonly [number, number, number];
  readonly real: Float32Array;
}

const complexAttributeProjectionCache = new WeakMap<
  DecodedComplexFieldVector,
  Map<string, ComplexAttributeProjection>
>();

export function resolveModeCompositionMeshPartRenderPlan<TBaseSurface>({
  baseSurface,
  compositionId,
  snapshot,
  targetId,
}: {
  baseSurface: ConfiguredBaseSurface<TBaseSurface>;
  compositionId: string | null;
  snapshot: ModeCompositionFieldLayerSnapshot | null | undefined;
  targetId: string;
}): ModeCompositionMeshPartRenderPlan<TBaseSurface> {
  const target = { targetId, targetKind: "object" } as const;
  const [plan] = buildModeCompositionRenderPlan({
    targets: [
      {
        baseSurface,
        modal: modalLifecycleFromSnapshot(compositionId, snapshot, targetId),
        target,
      },
    ],
  });
  return plan!;
}

function modalLifecycleFromSnapshot(
  compositionId: string | null,
  snapshot: ModeCompositionFieldLayerSnapshot | null | undefined,
  targetId: string,
): ModeCompositionModalResourceLifecycle<ModeCompositionViewportModalBuffer> {
  if (!snapshot) return { state: "absent" };
  const layer = snapshot.layer;
  if (!layer) return { state: "absent" };
  const modalIdentity = {
    compositionId: compositionId ?? "mode-composition:unavailable",
    layerId: layer.layer_id,
  };
  if (!layer.enabled || snapshot.status === "absent") {
    return { ...modalIdentity, state: "disabled" };
  }
  if (!compositionId || layer.target_id !== targetId) {
    return { ...modalIdentity, state: "error" };
  }
  if (snapshot.status === "preparing") {
    return { ...modalIdentity, state: "preparing" };
  }
  if (snapshot.status === "error") {
    return { ...modalIdentity, state: "error" };
  }
  const buffer = snapshot.field
    ? { field: snapshot.field, identity: snapshot.identity, layer }
    : null;
  if (snapshot.status === "ready") {
    return buffer
      ? {
          ...modalIdentity,
          buffer,
          identity: "matching",
          state: "ready",
          topology: "matching",
        }
      : { ...modalIdentity, state: "error" };
  }
  return {
    ...modalIdentity,
    identity: "matching",
    retainedBuffer: buffer,
    state: snapshot.status,
    topology: "matching",
  };
}

export function modeCompositionTargetIdForMeshPart(part: {
  readonly object_id?: string | null;
}): string | null {
  const objectId = part.object_id?.trim();
  if (!objectId) return null;
  return objectId.startsWith("object:") ? objectId : `object:${objectId}`;
}

export function buildModeCompositionScalarColorBuffer({
  field,
  geometryNodeIndices,
  layer,
  projectionKey,
  requiredSurfaceNodeIndices,
  topologyNodeCount,
}: {
  field: DecodedComplexFieldVector;
  geometryNodeIndices?: Uint32Array | null;
  layer: ModeCompositionLayer;
  projectionKey?: string;
  requiredSurfaceNodeIndices: Uint32Array;
  topologyNodeCount: number;
}): ScalarColorBuffer | null {
  if (!modeFieldMatchesLayer(field, layer, topologyNodeCount)) return null;
  if (geometryNodeIndices && !projectionKey?.trim()) return null;
  const projection = resolveComplexAttributeProjection(
    field,
    geometryNodeIndices ?? null,
    projectionKey ?? "indexed",
    topologyNodeCount,
  );
  if (!projection || !hasRequiredCoverage(field, requiredSurfaceNodeIndices)) {
    return null;
  }

  const amplitudeScale = layer.amplitude_scale;
  const colorMode = colorModeForComponent(layer.component);
  const range = resolveModeScalarRange(layer, projection, amplitudeScale);
  if (!range) return null;

  return {
    amplitudeScale,
    buildKey: rawModeBufferKey(
      field,
      layer,
      topologyNodeCount,
      projectionKey ?? "indexed",
    ),
    colors: new Float32Array(0),
    colorMode,
    colorPalette: resolveModeColorPalette(layer),
    complexImagValues: projection.imag,
    complexPhaseRad: layer.phase_rad + layer.animation.phase_offset_rad,
    complexRealValues: projection.real,
    complexRepresentation: layer.representation,
    phasorConvention: "exp_i_omega_t",
    quantityId: field.quantityId,
    range,
    sourceFieldBufferId: rawModeBufferKey(
      field,
      layer,
      topologyNodeCount,
      projectionKey ?? "indexed",
    ),
    targetRevision: rawModeBufferKey(
      field,
      layer,
      topologyNodeCount,
      projectionKey ?? "indexed",
    ),
    topologyRevision: field.meshTopologyRevision ?? undefined,
  };
}

function modeFieldMatchesLayer(
  field: DecodedComplexFieldVector,
  layer: ModeCompositionLayer,
  topologyNodeCount: number,
): boolean {
  const scopeId = field.scopeId?.replace(/^object:/, "") ?? null;
  return Boolean(
    layer.enabled &&
      Number.isSafeInteger(topologyNodeCount) &&
      topologyNodeCount > 0 &&
      Number.isFinite(layer.amplitude_scale) &&
      layer.amplitude_scale >= 0 &&
      Number.isFinite(layer.phase_rad) &&
      Number.isFinite(layer.animation.phase_offset_rad) &&
      field.componentCount === 3 &&
      field.formatVersion === 3 &&
      field.indexing === "explicit_node_indices" &&
      field.scopeKind === "object" &&
      scopeId === layer.object_id.replace(/^object:/, "") &&
      field.quantityId === layer.field_id &&
      field.pointCount > 0 &&
      field.valueCount === field.pointCount * 6 &&
      field.values.length === field.valueCount &&
      field.nodeIndices?.length === field.pointCount,
  );
}

function resolveComplexAttributeProjection(
  field: DecodedComplexFieldVector,
  geometryNodeIndices: Uint32Array | null,
  projectionKey: string,
  topologyNodeCount: number,
): ComplexAttributeProjection | null {
  let fieldCache = complexAttributeProjectionCache.get(field);
  if (!fieldCache) {
    fieldCache = new Map();
    complexAttributeProjectionCache.set(field, fieldCache);
  }
  const vertexCount = geometryNodeIndices?.length ?? topologyNodeCount;
  const key = [
    topologyNodeCount,
    vertexCount,
    field.meshTopologyHash ?? "none",
    projectionKey,
  ].join(":");
  const cached = fieldCache.get(key);
  if (cached) return cached;

  const nodeIndices = field.nodeIndices;
  if (!nodeIndices) return null;
  const real = new Float32Array(vertexCount * 3);
  const imag = new Float32Array(vertexCount * 3);
  const maxAbsReal = [0, 0, 0] as [number, number, number];
  const maxAbsImag = [0, 0, 0] as [number, number, number];
  const maxAbsMagnitude = [0, 0, 0] as [number, number, number];
  const pointByNode = new Map<number, number>();

  for (let point = 0; point < field.pointCount; point += 1) {
    const globalNode = nodeIndices[point];
    if (
      globalNode === undefined ||
      !Number.isSafeInteger(globalNode) ||
      globalNode < 0 ||
      globalNode >= topologyNodeCount ||
      pointByNode.has(globalNode)
    ) {
      return null;
    }
    pointByNode.set(globalNode, point);
    for (let component = 0; component < 3; component += 1) {
      const sourceOffset = (point * 3 + component) * 2;
      const re = field.values[sourceOffset];
      const im = field.values[sourceOffset + 1];
      if (re === undefined || im === undefined || !Number.isFinite(re) || !Number.isFinite(im)) {
        return null;
      }
      maxAbsReal[component] = Math.max(maxAbsReal[component], Math.abs(re));
      maxAbsImag[component] = Math.max(maxAbsImag[component], Math.abs(im));
      maxAbsMagnitude[component] = Math.max(
        maxAbsMagnitude[component],
        Math.hypot(re, im),
      );
    }
  }

  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const globalNode = geometryNodeIndices?.[vertex] ?? vertex;
    if (
      globalNode === undefined ||
      !Number.isSafeInteger(globalNode) ||
      globalNode < 0 ||
      globalNode >= topologyNodeCount
    ) {
      return null;
    }
    const point = pointByNode.get(globalNode);
    if (point === undefined) continue;
    for (let component = 0; component < 3; component += 1) {
      const sourceOffset = (point * 3 + component) * 2;
      const targetOffset = vertex * 3 + component;
      real[targetOffset] = field.values[sourceOffset]!;
      imag[targetOffset] = field.values[sourceOffset + 1]!;
    }
  }

  const projection = { imag, maxAbsImag, maxAbsMagnitude, maxAbsReal, real };
  fieldCache.set(key, projection);
  return projection;
}

function hasRequiredCoverage(
  field: DecodedComplexFieldVector,
  requiredSurfaceNodeIndices: Uint32Array,
): boolean {
  const nodeIndices = field.nodeIndices;
  if (!nodeIndices) return false;
  const available = new Set(nodeIndices);
  for (const nodeIndex of requiredSurfaceNodeIndices) {
    if (!available.has(nodeIndex)) return false;
  }
  return true;
}

function colorModeForComponent(
  component: ModeCompositionLayer["component"],
): string {
  if (component === "vector") return "orientation";
  return component;
}

function resolveModeScalarRange(
  layer: ModeCompositionLayer,
  projection: ComplexAttributeProjection,
  amplitudeScale: number,
): ScalarRange | null {
  const appearance = layer.appearance;
  if (!appearance.auto_range) {
    const min = appearance.range_min;
    const max = appearance.range_max;
    return typeof min === "number" &&
      typeof max === "number" &&
      Number.isFinite(min) &&
      Number.isFinite(max) &&
      min < max
      ? { max, min }
      : null;
  }
  if (layer.representation === "phase") {
    return { max: Math.PI, min: -Math.PI };
  }

  const componentIndex =
    layer.component === "x" ? 0 : layer.component === "y" ? 1 : layer.component === "z" ? 2 : null;
  const maxima =
    layer.representation === "real"
      ? projection.maxAbsReal
      : layer.representation === "imag"
        ? projection.maxAbsImag
        : projection.maxAbsMagnitude;
  const rawMaximum = componentIndex === null
    ? Math.hypot(maxima[0], maxima[1], maxima[2])
    : maxima[componentIndex];
  const maximum = Math.max(rawMaximum * amplitudeScale, 1e-30);
  const signed =
    layer.representation === "real" ||
    layer.representation === "imag" ||
    layer.representation === "phase_rotated_real";
  return signed && appearance.symmetric_zero
    ? { max: maximum, min: -maximum }
    : { max: maximum, min: signed ? -maximum : 0 };
}

function resolveModeColorPalette(layer: ModeCompositionLayer): string {
  const configured = layer.appearance.colormap.trim().toLowerCase();
  if (layer.representation === "phase") return configured || "twilight";
  if (layer.representation === "abs" || layer.component === "magnitude") {
    return configured || "viridis";
  }
  return configured || "coolwarm";
}

function rawModeBufferKey(
  field: DecodedComplexFieldVector,
  layer: ModeCompositionLayer,
  topologyNodeCount: number,
  projectionKey: string,
): string {
  return [
    "mode-composition",
    layer.mode.run_id,
    layer.mode.stage_id,
    layer.mode.artifact_revision,
    layer.mode.sample_id,
    layer.mode.mode_id,
    layer.field_id,
    layer.object_id,
    field.domainGenerationId ?? "none",
    field.meshTopologyHash ?? "none",
    topologyNodeCount,
    projectionKey,
  ].join(":");
}
