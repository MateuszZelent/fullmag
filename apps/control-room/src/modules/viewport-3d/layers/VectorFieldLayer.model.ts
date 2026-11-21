import type { Viewport3DRenderAdoptionIdentity, Viewport3DRenderAdoptionRegistry } from "../model/viewport3DRenderAdoptionRegistry";
import type { SessionResourceIdentity } from "@/kernel/resources/sessionResourceIdentity";
import { type VectorGlyphBuildResult } from "./vectorGlyphBuildScheduler";
import type { Viewport3DVectorBuildReference } from "../viewport3dRenderModel";
import { BufferAttribute, BufferGeometry, InstancedBufferAttribute, InstancedMesh, MeshBasicMaterial } from "three";
import { RENDER_POLICIES } from "./viewport3DRenderPolicy";

// V1-matched proportions for better visual quality.
const DEFAULT_HEAD_RADIUS_RATIO = 0.1;

const DEFAULT_SHAFT_RADIUS_RATIO = 0.035;

export interface VectorGlyphUploadKeys {
  colorKey: string;
  matrixKey: string;
  targetRevision: string | null;
}

export interface VectorGlyphUploadKeyInput {
  buildKey: string;
  colorByteLength: number;
  glyphCount: number;
  targetRevision: string | null;
  transformByteLength: number;
}

export function createVectorGlyphColorUploadRollback({
  attribute,
  count,
  head,
  material,
  shaft,
  start,
}: {
  attribute: InstancedBufferAttribute;
  count: number;
  head: InstancedMesh;
  material: MeshBasicMaterial;
  shaft: InstancedMesh;
  start: number;
}): () => void {
  const colorStart = start * 3;
  const priorColors = (attribute.array as Float32Array).slice(
    colorStart,
    colorStart + count * 3,
  );
  const priorRanges = attribute.updateRanges.map(({ count: rangeCount, start: rangeStart }) => ({
    count: rangeCount,
    start: rangeStart,
  }));
  const priorHeadCount = head.count;
  const priorHeadInstanceColor = head.instanceColor;
  const priorMaterialColor = material.color.clone();
  const priorMaterialVertexColors = material.vertexColors;
  const priorShaftCount = shaft.count;
  const priorShaftInstanceColor = shaft.instanceColor;

  return () => {
    (attribute.array as Float32Array).set(priorColors, colorStart);
    restoreVectorGlyphUpdateRanges(attribute, priorRanges);
    shaft.count = priorShaftCount;
    head.count = priorHeadCount;
    shaft.instanceColor = priorShaftInstanceColor;
    head.instanceColor = priorHeadInstanceColor;
    material.color.copy(priorMaterialColor);
    material.vertexColors = priorMaterialVertexColors;
    material.needsUpdate = true;
  };
}

export function createVectorGlyphMatrixUploadRollback({
  count,
  head,
  shaft,
  start,
}: {
  count: number;
  head: InstancedMesh;
  shaft: InstancedMesh;
  start: number;
}): () => void {
  const matrixStart = start * 16;
  const matrixLength = count * 16;
  const priorHeadMatrices = (head.instanceMatrix.array as Float32Array).slice(
    matrixStart,
    matrixStart + matrixLength,
  );
  const priorHeadRanges = head.instanceMatrix.updateRanges.map(
    ({ count: rangeCount, start: rangeStart }) => ({
      count: rangeCount,
      start: rangeStart,
    }),
  );
  const priorHeadCount = head.count;
  const priorShaftMatrices = (shaft.instanceMatrix.array as Float32Array).slice(
    matrixStart,
    matrixStart + matrixLength,
  );
  const priorShaftRanges = shaft.instanceMatrix.updateRanges.map(
    ({ count: rangeCount, start: rangeStart }) => ({
      count: rangeCount,
      start: rangeStart,
    }),
  );
  const priorShaftCount = shaft.count;

  return () => {
    (shaft.instanceMatrix.array as Float32Array).set(
      priorShaftMatrices,
      matrixStart,
    );
    (head.instanceMatrix.array as Float32Array).set(
      priorHeadMatrices,
      matrixStart,
    );
    restoreVectorGlyphUpdateRanges(shaft.instanceMatrix, priorShaftRanges);
    restoreVectorGlyphUpdateRanges(head.instanceMatrix, priorHeadRanges);
    shaft.count = priorShaftCount;
    head.count = priorHeadCount;
  };
}

function restoreVectorGlyphUpdateRanges(
  attribute: InstancedBufferAttribute,
  ranges: readonly { readonly count: number; readonly start: number }[],
): void {
  attribute.clearUpdateRanges();
  for (const range of ranges) {
    attribute.addUpdateRange(range.start, range.count);
  }
}

export function createVectorGlyphUploadKeys({
  buildKey,
  colorByteLength,
  glyphCount,
  targetRevision,
  transformByteLength,
}: VectorGlyphUploadKeyInput): VectorGlyphUploadKeys {
  const targetKey = targetRevision ?? "unknown";
  const baseKey = `${buildKey}:target=${targetKey}:count=${glyphCount}`;
  return {
    colorKey: `vector-glyph-colors:${baseKey}:bytes=${colorByteLength}`,
    matrixKey: `vector-glyph-matrices:${baseKey}:bytes=${transformByteLength}`,
    targetRevision,
  };
}

export interface VectorFieldLayerVectorStyle {
  alpha?: number | null;
  monoColor?: string | null;
  thickness?: number | null;
}

export function resolveVectorFieldLayerStyle({
  colorMode,
  fallbackColor,
  opacity,
  style,
}: {
  colorMode: string;
  fallbackColor: string;
  opacity: number;
  style?: VectorFieldLayerVectorStyle;
}) {
  const thickness = clampStyleScale(style?.thickness ?? 1);
  return {
    headRadiusRatio: DEFAULT_HEAD_RADIUS_RATIO * thickness,
    materialColor:
      colorMode === "monochrome" && style?.monoColor
        ? style.monoColor
        : fallbackColor,
    materialOpacity: clampOpacity(opacity * (style?.alpha ?? 1)),
    shaftRadiusRatio: DEFAULT_SHAFT_RADIUS_RATIO * thickness,
  };
}

export function resolveVectorGlyphDepthPolicy(renderOnTop = false): {
  depthTest: boolean;
  depthWrite: boolean;
} {
  const policy = RENDER_POLICIES.glyphs;
  return {
    depthTest: renderOnTop ? false : policy.depthTest,
    depthWrite: renderOnTop ? false : policy.depthWrite,
  };
}

export function syncVectorGlyphColorState({
  hasInstanceColors,
  head,
  instanceColorAttr,
  material,
  materialColor,
  shaft,
}: {
  hasInstanceColors: boolean;
  head: InstancedMesh;
  instanceColorAttr: InstancedBufferAttribute;
  material: MeshBasicMaterial;
  materialColor: string;
  shaft: InstancedMesh;
}) {
  const nextInstanceColor = hasInstanceColors ? instanceColorAttr : null;
  shaft.instanceColor = nextInstanceColor;
  head.instanceColor = nextInstanceColor;
  material.vertexColors = hasInstanceColors;
  material.color.set(hasInstanceColors ? "white" : materialColor);
  if (hasInstanceColors) {
    instanceColorAttr.needsUpdate = true;
  }
  material.needsUpdate = true;
}

export function syncVectorGlyphMaterialStyle({
  glyphTransparent,
  material,
  materialColor,
  materialOpacity,
  toneMapped,
  useInstanceColors,
}: {
  glyphTransparent: boolean;
  material: MeshBasicMaterial;
  materialColor: string;
  materialOpacity: number;
  toneMapped: boolean;
  useInstanceColors: boolean;
}) {
  material.opacity = materialOpacity;
  material.transparent = glyphTransparent || materialOpacity < 0.99;
  material.toneMapped = toneMapped;
  material.vertexColors = useInstanceColors;
  material.color.set(useInstanceColors ? "white" : materialColor);
  material.needsUpdate = true;
}

export function ensureWhiteVertexColorAttribute(
  geometry: BufferGeometry,
): BufferGeometry {
  const position = geometry.getAttribute("position");
  const vertexCount = position?.count ?? 0;
  const existing = geometry.getAttribute("color");
  if (existing?.itemSize === 3 && existing.count === vertexCount) {
    return geometry;
  }

  const colors = new Float32Array(vertexCount * 3);
  colors.fill(1);
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  return geometry;
}

export function identifyVectorGlyphBuildResult(
  result: VectorGlyphBuildResult,
  buildReference: Viewport3DVectorBuildReference | null,
): VectorGlyphBuildResult {
  return {
    ...result,
    sourceFieldBufferId: buildReference?.fieldBufferId ?? null,
    sourceResourceKey: buildReference?.resourceKey ?? null,
    sourceVectorBuildKey: buildReference?.buildKey ?? null,
  };
}

export function resolveVectorFieldAdoptionBuildKey(
  result: VectorGlyphBuildResult | null,
): string | null {
  return result?.sourceVectorBuildKey ?? null;
}

export function recordVectorFieldAdoption({
  buildKey,
  byteLength,
  carrierId,
  fieldBufferId,
  glyphCount,
  ownerId,
  resourceKey = null,
  registry,
  sessionIdentity,
}: {
  buildKey: string;
  byteLength: number;
  carrierId: string;
  fieldBufferId: string | null;
  glyphCount: number;
  ownerId?: string;
  resourceKey?: string | null;
  registry: Viewport3DRenderAdoptionRegistry;
  sessionIdentity?: SessionResourceIdentity | null;
}): Viewport3DRenderAdoptionIdentity {
  const adoption = vectorFieldAdoptionIdentity({
    buildKey,
    carrierId,
    fieldBufferId,
    resourceKey,
  });
  registry.recordVectorAdoption({
    byteLength,
    carrierId: adoption.carrierId,
    fieldBufferId: adoption.fieldBufferId,
    itemCount: glyphCount,
    ownerId,
    resourceKey: adoption.resourceKey,
    sessionIdentity,
    vectorBuildKey: adoption.vectorBuildKey ?? buildKey,
  });
  return adoption;
}

export function vectorFieldAdoptionIdentity({
  buildKey,
  carrierId,
  fieldBufferId,
  resourceKey,
}: {
  buildKey: string;
  carrierId: string;
  fieldBufferId: string | null;
  resourceKey: string | null;
}): Viewport3DRenderAdoptionIdentity {
  return {
    carrierId,
    fieldBufferId,
    kind: "vector",
    resourceKey,
    scalarBufferKey: null,
    vectorBuildKey: buildKey,
  };
}

function clampOpacity(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampStyleScale(value: number): number {
  return Math.max(0.1, Math.min(8, value));
}
