"use client";

import type { DecodedFieldVector } from "@/kernel/api/codecs";
import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";
import { type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef, memo } from "react";
import {
  BoxGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from "three";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import type { Viewport3DVectorAnchorMode } from "../viewport3dRenderModel";
import {
  RENDER_POLICIES,
  resolveSurfacePolicy,
  surfaceMaterialPolicyProps,
} from "./viewport3DRenderPolicy";

import type { FdmGridRenderDomain } from "../viewport3dDomainAdapter";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { ScalarColorBuffer } from "../viewport3dFieldMapping";
import type { Viewport3DColors } from "../viewport3dTypes";
import type { Viewport3DMaterialProfile } from "./viewport3DMaterialProfile";
import {
  opacityFromSettings,
  surfaceMaterialColorFromSettings,
  vectorColorModeFromSettings,
  vectorStyleFromSettings,
  wireframeColorFromSettings,
  wireframeOpacityFromSettings,
} from "./viewport3DLayerSettings";
import {
  VectorFieldLayer,
  type VectorFieldLayerVectorStyle,
} from "./VectorFieldLayer";

/** Number of floats per vector segment: [sx,sy,sz, ex,ey,ez, relMag] */
const VECTOR_SEGMENT_STRIDE = 7;

export interface FdmCuboidInstanceModel {
  cellSize: [number, number, number];
  cellIndices: Uint32Array;
  centers: Float32Array;
  count: number;
}

interface FdmCuboidInstanceModelOptions {
  fieldVector?: DecodedFieldVector | null;
  voxelFillRatio?: number;
  voxelMagnitudeThreshold?: number;
  voxelTopography?: FdmVoxelTopographyOptions;
}

export interface FdmVoxelTopographyOptions {
  amplitudeCells: number;
  component: "magnitude" | "x" | "y" | "z";
  enabled: boolean;
}

const IDENTITY_QUATERNION = new Quaternion();
const CELL_VISUAL_FILL = 0.92;

export const FDM_CUBOID_UPLOAD_BATCH_SIZE = 2048;

export interface FdmCuboidUploadBatch {
  end: number;
  start: number;
}

type FdmUploadTaskHandle = ReturnType<typeof setTimeout>;

export function buildFdmCuboidUploadBatches(
  count: number,
  batchSize = FDM_CUBOID_UPLOAD_BATCH_SIZE,
): FdmCuboidUploadBatch[] {
  const safeCount = Math.max(0, Math.floor(count));
  const safeBatchSize = Math.max(1, Math.floor(batchSize));
  const batches: FdmCuboidUploadBatch[] = [];

  for (let start = 0; start < safeCount; start += safeBatchSize) {
    batches.push({ end: Math.min(start + safeBatchSize, safeCount), start });
  }

  return batches;
}

function requestFdmUploadTask(callback: () => void): FdmUploadTaskHandle {
  return setTimeout(callback, 0);
}

function cancelFdmUploadTask(handle: FdmUploadTaskHandle): void {
  clearTimeout(handle);
}

function markFdmCuboidUpload(name: string): string | null {
  const target = globalThis.performance;
  if (!target?.mark || !target?.measure) return null;

  const startMark = `${name}:start:${Date.now()}:${Math.random()}`;
  target.mark(startMark);
  return startMark;
}

function measureFdmCuboidUpload(name: string, startMark: string | null): void {
  const target = globalThis.performance;
  if (!startMark || !target?.mark || !target?.measure) return;

  const endMark = `${name}:end:${Date.now()}:${Math.random()}`;
  target.mark(endMark);
  try {
    target.measure(name, startMark, endMark);
  } catch {
    // Gracefully ignore measurement errors
  }
}

export function buildFdmCuboidInstanceModel(
  domain: FdmGridRenderDomain | null,
  options: FdmCuboidInstanceModelOptions = {},
): FdmCuboidInstanceModel | null {
  if (!domain || domain.displayCellCount <= 0 || domain.totalCells <= 0) {
    return null;
  }

  const candidateCount = Math.min(domain.displayCellCount, domain.totalCells);
  const [nx, ny, nz] = domain.shape;
  const [dx, dy, dz] = domain.spacing;
  const [ox, oy, oz] = domain.origin;
  const fillRatio = clampVoxelFillRatio(options.voxelFillRatio ?? 0.92);
  const threshold = Math.max(0, options.voxelMagnitudeThreshold ?? 0);
  const topography = normalizeVoxelTopography(options.voxelTopography);
  const gridCells = Math.max(nx * ny * nz, 1);
  const totalCells = Math.min(domain.totalCells, gridCells);
  const sampledCellIndices: number[] = [];

  for (let instance = 0; instance < candidateCount; instance += 1) {
    const cellIndex = Math.min(
      totalCells - 1,
      Math.floor((instance * totalCells) / candidateCount),
    );
    if (!cellPassesMagnitudeThreshold(options.fieldVector, cellIndex, threshold)) {
      continue;
    }
    sampledCellIndices.push(cellIndex);
  }

  const count = sampledCellIndices.length;
  if (count <= 0) return null;

  const centers = new Float32Array(count * 3);
  const cellIndices = new Uint32Array(count);

  for (let instance = 0; instance < count; instance += 1) {
    const cellIndex = sampledCellIndices[instance] ?? 0;
    cellIndices[instance] = cellIndex;
    const ix = cellIndex % nx;
    const iy = Math.floor(cellIndex / nx) % ny;
    const iz = Math.floor(cellIndex / (nx * ny)) % nz;
    const target = instance * 3;

    centers[target] = ox + (ix + 0.5) * dx;
    centers[target + 1] = oy + (iy + 0.5) * dy;
    centers[target + 2] =
      oz +
      (iz + 0.5) * dz +
      resolveVoxelTopographyDisplacement(
        options.fieldVector,
        cellIndex,
        topography,
        dz,
      );
  }

  return {
    cellSize: [
      Math.max(dx * fillRatio, 1e-18),
      Math.max(dy * fillRatio, 1e-18),
      Math.max(dz * fillRatio, 1e-18),
    ],
    cellIndices,
    centers,
    count,
  };
}

function clampVoxelFillRatio(value: number): number {
  if (!Number.isFinite(value)) return CELL_VISUAL_FILL;
  return Math.min(Math.max(value, 0.1), 1);
}

function cellPassesMagnitudeThreshold(
  fieldVector: DecodedFieldVector | null | undefined,
  cellIndex: number,
  threshold: number,
): boolean {
  if (threshold <= 0 || !fieldVector) return true;
  if (cellIndex >= fieldVector.pointCount) return false;

  const offset = cellIndex * fieldVector.nComp;
  if (fieldVector.nComp === 1) {
    return Math.abs(fieldVector.values[offset] ?? 0) >= threshold;
  }

  const magnitude = Math.hypot(
    fieldVector.values[offset] ?? 0,
    fieldVector.values[offset + 1] ?? 0,
    fieldVector.values[offset + 2] ?? 0,
  );
  return magnitude >= threshold;
}

function normalizeVoxelTopography(
  value: FdmVoxelTopographyOptions | null | undefined,
): FdmVoxelTopographyOptions {
  if (!value?.enabled) {
    return { amplitudeCells: 0, component: "z", enabled: false };
  }
  const amplitudeCells = Number.isFinite(value.amplitudeCells)
    ? Math.max(-16, Math.min(16, value.amplitudeCells))
    : 0;
  const component =
    value.component === "x" ||
    value.component === "y" ||
    value.component === "z" ||
    value.component === "magnitude"
      ? value.component
      : "z";
  return {
    amplitudeCells,
    component,
    enabled: amplitudeCells !== 0,
  };
}

function resolveVoxelTopographyDisplacement(
  fieldVector: DecodedFieldVector | null | undefined,
  cellIndex: number,
  topography: FdmVoxelTopographyOptions,
  cellHeight: number,
): number {
  if (!topography.enabled || !fieldVector || cellIndex >= fieldVector.pointCount) {
    return 0;
  }

  const offset = cellIndex * fieldVector.nComp;
  const x = fieldVector.values[offset] ?? 0;
  const y = fieldVector.nComp > 1 ? fieldVector.values[offset + 1] ?? 0 : 0;
  const z = fieldVector.nComp > 2 ? fieldVector.values[offset + 2] ?? 0 : 0;
  const value =
    topography.component === "x"
      ? x
      : topography.component === "y"
        ? y
        : topography.component === "z"
          ? z
          : Math.hypot(x, y, z);

  return value * topography.amplitudeCells * cellHeight;
}

type FdmVectorSegmentCache = WeakMap<
  DecodedFieldVector,
  Map<string, Float32Array | null>
>;

const fdmVectorSegmentCache = new WeakMap<
  FdmCuboidInstanceModel,
  FdmVectorSegmentCache
>();

function cachedFdmVectorSegments(
  model: FdmCuboidInstanceModel,
  fieldVector: DecodedFieldVector,
  cacheKey: string,
): Float32Array | null | undefined {
  const fieldCache = fdmVectorSegmentCache.get(model)?.get(fieldVector);
  if (!fieldCache?.has(cacheKey)) return undefined;
  return fieldCache.get(cacheKey) ?? null;
}

function cacheFdmVectorSegments(
  model: FdmCuboidInstanceModel,
  fieldVector: DecodedFieldVector,
  cacheKey: string,
  segments: Float32Array | null,
): void {
  let modelCache = fdmVectorSegmentCache.get(model);
  if (!modelCache) {
    modelCache = new WeakMap();
    fdmVectorSegmentCache.set(model, modelCache);
  }

  let fieldCache = modelCache.get(fieldVector);
  if (!fieldCache) {
    fieldCache = new Map();
    modelCache.set(fieldVector, fieldCache);
  }

  fieldCache.set(cacheKey, segments);
}

export function buildFdmVectorSegments(
  model: FdmCuboidInstanceModel | null,
  fieldVector: DecodedFieldVector | null | undefined,
  scale: number,
  maxVectors: number,
  options: { anchorMode?: Viewport3DVectorAnchorMode } = {},
): Float32Array | null {
  if (
    !model ||
    !fieldVector ||
    fieldVector.nComp < 3 ||
    fieldVector.pointCount === 0 ||
    maxVectors <= 0
  ) {
    return null;
  }

  const vectorCount = Math.min(model.count, fieldVector.pointCount, maxVectors);
  const anchorMode = options.anchorMode ?? "center";
  const cacheKey = `${scale}:${maxVectors}:${anchorMode}`;
  const cachedSegments = cachedFdmVectorSegments(model, fieldVector, cacheKey);
  if (cachedSegments !== undefined) return cachedSegments;

  if (vectorCount <= 0) {
    cacheFdmVectorSegments(model, fieldVector, cacheKey, null);
    return null;
  }

  const stride = Math.max(1, Math.floor(model.count / vectorCount));

  let maxMagnitude = 0;
  for (let vector = 0; vector < vectorCount; vector += 1) {
    const instance = Math.min(model.count - 1, vector * stride);
    const pointIndex = model.cellIndices[instance] ?? 0;
    if (pointIndex >= fieldVector.pointCount) continue;
    const offset = pointIndex * fieldVector.nComp;
    const magnitude = Math.hypot(
      fieldVector.values[offset] ?? 0,
      fieldVector.values[offset + 1] ?? 0,
      fieldVector.values[offset + 2] ?? 0,
    );
    maxMagnitude = Math.max(maxMagnitude, magnitude);
  }

  const scaleMagnitude = Math.max(maxMagnitude, 1e-12);
  const halfScale = scale / 2;
  const segments = new Float32Array(vectorCount * VECTOR_SEGMENT_STRIDE);

  for (let vector = 0; vector < vectorCount; vector += 1) {
    const instance = Math.min(model.count - 1, vector * stride);
    const pointIndex = model.cellIndices[instance] ?? 0;
    if (pointIndex >= fieldVector.pointCount) continue;

    const positionOffset = instance * 3;
    const valueOffset = pointIndex * fieldVector.nComp;
    const target = vector * VECTOR_SEGMENT_STRIDE;
    const x = model.centers[positionOffset] ?? 0;
    const y = model.centers[positionOffset + 1] ?? 0;
    const z = model.centers[positionOffset + 2] ?? 0;
    const vx = fieldVector.values[valueOffset] ?? 0;
    const vy = fieldVector.values[valueOffset + 1] ?? 0;
    const vz = fieldVector.values[valueOffset + 2] ?? 0;
    const length = Math.hypot(vx, vy, vz) || 1;
    const ux = vx / length;
    const uy = vy / length;
    const uz = vz / length;

    if (anchorMode === "tail") {
      segments[target] = x;
      segments[target + 1] = y;
      segments[target + 2] = z;
      segments[target + 3] = x + ux * scale;
      segments[target + 4] = y + uy * scale;
      segments[target + 5] = z + uz * scale;
    } else {
      segments[target] = x - ux * halfScale;
      segments[target + 1] = y - uy * halfScale;
      segments[target + 2] = z - uz * halfScale;
      segments[target + 3] = x + ux * halfScale;
      segments[target + 4] = y + uy * halfScale;
      segments[target + 5] = z + uz * halfScale;
    }
    segments[target + 6] = length / scaleMagnitude;
  }

  cacheFdmVectorSegments(model, fieldVector, cacheKey, segments);
  return segments;
}

export function resolveFdmVectorGlyphScale(
  model: FdmCuboidInstanceModel | null,
  requestedScale: number,
): number {
  const safeScale = Math.max(requestedScale, 1e-12);
  if (!model) return safeScale;

  const maxCellSize = Math.max(...model.cellSize);
  const localCap = Math.max(maxCellSize * 0.75, 1e-12);
  return Math.min(safeScale, localCap);
}

interface FdmCuboidMatrixUploadOptions {
  invalidate: () => void;
  model: FdmCuboidInstanceModel | null;
  shaderVisible: boolean;
  surfaceRef: { current: InstancedMesh | null };
  tracker: Viewport3DResourceTracker;
  usesInstanceColors: boolean;
  wireframeRef: { current: InstancedMesh | null };
  wireframeVisible: boolean;
}

function useFdmCuboidMatrixUpload({
  invalidate,
  model,
  shaderVisible,
  surfaceRef,
  tracker,
  usesInstanceColors,
  wireframeRef,
  wireframeVisible,
}: FdmCuboidMatrixUploadOptions): void {
  useEffect(() => {
    if (!model) return;

    const meshes = [surfaceRef.current, wireframeRef.current].filter(
      (mesh): mesh is InstancedMesh => Boolean(mesh),
    );
    if (meshes.length === 0) return;

    const batches = buildFdmCuboidUploadBatches(model.count);
    if (batches.length === 0) return;

    const matrix = new Matrix4();
    const position = new Vector3();
    const scale = new Vector3(...model.cellSize);
    const startMark = markFdmCuboidUpload(
      "fullmag.viewport3d.uploadFdmCuboidMatrices",
    );
    let cancelled = false;
    let taskHandle: FdmUploadTaskHandle | null = null;

    const uploadBatch = (batchIndex: number) => {
      if (cancelled) return;

      const batch = batches[batchIndex];
      if (!batch) return;

      for (const mesh of meshes) {
        for (let index = batch.start; index < batch.end; index += 1) {
          const offset = index * 3;
          position.set(
            model.centers[offset] ?? 0,
            model.centers[offset + 1] ?? 0,
            model.centers[offset + 2] ?? 0,
          );
          matrix.compose(position, IDENTITY_QUATERNION, scale);
          mesh.setMatrixAt(index, matrix);
        }
      }

      const nextBatch = batchIndex + 1;
      if (nextBatch < batches.length) {
        taskHandle = requestFdmUploadTask(() => uploadBatch(nextBatch));
        return;
      }

      for (const mesh of meshes) {
        mesh.instanceMatrix.needsUpdate = true;
      }
      measureFdmCuboidUpload(
        "fullmag.viewport3d.uploadFdmCuboidMatrices",
        startMark,
      );
      tracker.recordDirtyFrame("fdm-cuboids");
      invalidate();
    };

    uploadBatch(0);

    return () => {
      cancelled = true;
      if (taskHandle !== null) {
        cancelFdmUploadTask(taskHandle);
      }
    };
  }, [
    invalidate,
    model,
    shaderVisible,
    surfaceRef,
    tracker,
    usesInstanceColors,
    wireframeRef,
    wireframeVisible,
  ]);
}

interface FdmCuboidColorUploadOptions {
  invalidate: () => void;
  model: FdmCuboidInstanceModel | null;
  surfaceColors: ScalarColorBuffer | null;
  surfaceRef: { current: InstancedMesh | null };
  tracker: Viewport3DResourceTracker;
  usesInstanceColors: boolean;
}

function useFdmCuboidColorUpload({
  invalidate,
  model,
  surfaceColors,
  surfaceRef,
  tracker,
  usesInstanceColors,
}: FdmCuboidColorUploadOptions): void {
  useEffect(() => {
    const mesh = surfaceRef.current;
    if (!mesh || !model || !usesInstanceColors || !surfaceColors) return;

    const batches = buildFdmCuboidUploadBatches(model.count);
    if (batches.length === 0) return;

    const color = new Color();
    const startMark = markFdmCuboidUpload(
      "fullmag.viewport3d.uploadFdmCuboidColors",
    );
    let cancelled = false;
    let taskHandle: FdmUploadTaskHandle | null = null;

    const uploadBatch = (batchIndex: number) => {
      if (cancelled) return;

      const batch = batches[batchIndex];
      if (!batch) return;

      for (let index = batch.start; index < batch.end; index += 1) {
        const offset = index * 3;
        color.setRGB(
          surfaceColors.colors[offset] ?? 0,
          surfaceColors.colors[offset + 1] ?? 0,
          surfaceColors.colors[offset + 2] ?? 0,
        );
        mesh.setColorAt(index, color);
      }

      const nextBatch = batchIndex + 1;
      if (nextBatch < batches.length) {
        taskHandle = requestFdmUploadTask(() => uploadBatch(nextBatch));
        return;
      }

      if (mesh.instanceColor) {
        mesh.instanceColor.needsUpdate = true;
      }
      measureFdmCuboidUpload(
        "fullmag.viewport3d.uploadFdmCuboidColors",
        startMark,
      );
      tracker.recordDirtyFrame("fdm-cuboid-colors");
      invalidate();
    };

    uploadBatch(0);

    return () => {
      cancelled = true;
      if (taskHandle !== null) {
        cancelFdmUploadTask(taskHandle);
      }
    };
  }, [
    invalidate,
    model,
    surfaceColors,
    surfaceRef,
    tracker,
    usesInstanceColors,
  ]);
}

export const FdmCuboidLayer = memo(function FdmCuboidLayer({
  colors,
  domain,
  materialProfile,
  onSelectDomain,
  settings,
  surfaceColors,
  tracker,
  vectorColorMode,
  vectorScale,
  vectorStyle,
  fieldVector,
  instanceModel,
  maxVectorGlyphs,
  voxelFillRatio,
  voxelMagnitudeThreshold,
  voxelTopography,
}: {
  colors: Viewport3DColors;
  domain: FdmGridRenderDomain | null;
  fieldVector: DecodedFieldVector | null | undefined;
  instanceModel?: FdmCuboidInstanceModel | null;
  maxVectorGlyphs: number;
  materialProfile: Viewport3DMaterialProfile;
  onSelectDomain: () => void;
  settings: VisualizationTargetSettings;
  surfaceColors: ScalarColorBuffer | null;
  tracker: Viewport3DResourceTracker;
  vectorColorMode: string;
  vectorScale: number;
  vectorStyle: VectorFieldLayerVectorStyle;
  voxelFillRatio: number;
  voxelMagnitudeThreshold: number;
  voxelTopography: FdmVoxelTopographyOptions;
}) {
  const invalidate = useBatchedInvalidate();
  const surfaceRef = useRef<InstancedMesh>(null);
  const wireframeRef = useRef<InstancedMesh>(null);
  const model = useMemo(
    () =>
      instanceModel !== undefined
        ? instanceModel
        : buildFdmCuboidInstanceModel(domain, {
            fieldVector,
            voxelFillRatio,
            voxelMagnitudeThreshold,
            voxelTopography,
          }),
    [
      domain,
      fieldVector,
      instanceModel,
      voxelFillRatio,
      voxelMagnitudeThreshold,
      voxelTopography,
    ],
  );
  const geometry = useMemo(
    () => tracker.track("geometry", new BoxGeometry(1, 1, 1)),
    [tracker],
  );
  const vectorSegments = useMemo(
    () =>
      buildFdmVectorSegments(
        model,
        fieldVector,
        resolveFdmVectorGlyphScale(model, vectorScale),
        maxVectorGlyphs,
        { anchorMode: settings.vectorCenteringEnabled ? "center" : "tail" },
      ),
    [
      fieldVector,
      maxVectorGlyphs,
      model,
      settings.vectorCenteringEnabled,
      vectorScale,
    ],
  );
  const surfaceOpacity = opacityFromSettings(settings);
  const surfacePolicy = resolveSurfacePolicy(surfaceOpacity);
  const usesInstanceColors = Boolean(
    surfaceColors && surfaceColors.colors.length === (model?.count ?? 0) * 3,
  );
  const surfaceMaterial = useMemo(
    () =>
      tracker.track(
        "material",
        new MeshStandardMaterial({
          color: surfaceMaterialColorFromSettings(
            settings,
            colors.mesh,
            usesInstanceColors,
          ),
          opacity: surfaceOpacity,
          vertexColors: usesInstanceColors,
          ...materialProfile.magneticSurface,
          ...surfaceMaterialPolicyProps(surfaceOpacity),
        }),
      ),
    [
      colors.mesh,
      materialProfile.magneticSurface,
      settings,
      surfaceOpacity,
      tracker,
      usesInstanceColors,
    ],
  );
  const wireframePolicy = RENDER_POLICIES.featureEdges;
  const wireframeMaterial = useMemo(
    () =>
      tracker.track(
        "material",
        new MeshBasicMaterial({
          color: wireframeColorFromSettings(settings, colors.wire),
          opacity: wireframeOpacityFromSettings(
            settings,
            materialProfile.featureEdges,
          ),
          transparent: wireframePolicy.transparent,
          depthWrite: wireframePolicy.depthWrite,
          depthTest: wireframePolicy.depthTest,
          side: wireframePolicy.side,
          wireframe: true,
        }),
      ),
    [colors.wire, materialProfile.featureEdges, settings, tracker, wireframePolicy],
  );

  useEffect(() => () => tracker.release("geometry", geometry), [geometry, tracker]);
  useEffect(
    () => () => tracker.release("material", surfaceMaterial),
    [surfaceMaterial, tracker],
  );
  useEffect(
    () => () => tracker.release("material", wireframeMaterial),
    [wireframeMaterial, tracker],
  );

  useFdmCuboidMatrixUpload({
    invalidate,
    model,
    shaderVisible: settings.shaderVisible,
    surfaceRef,
    tracker,
    usesInstanceColors,
    wireframeRef,
    wireframeVisible: settings.wireframeVisible,
  });

  useFdmCuboidColorUpload({
    invalidate,
    model,
    surfaceColors,
    surfaceRef,
    tracker,
    usesInstanceColors,
  });

  if (
    !model ||
    !settings.visible ||
    (!settings.shaderVisible && !settings.wireframeVisible)
  ) {
    return null;
  }

  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onSelectDomain();
  };

  return (
    <group onPointerDown={handlePointerDown}>
      {settings.shaderVisible ? (
        <instancedMesh
          args={[geometry, surfaceMaterial, model.count]}
          frustumCulled={false}
          key={`fdm-cuboids-surface-${model.count}-${usesInstanceColors ? "field" : "solid"}`}
          ref={surfaceRef}
          renderOrder={surfacePolicy.renderOrder}
        />
      ) : null}
      {settings.wireframeVisible ? (
        <instancedMesh
          args={[geometry, wireframeMaterial, model.count]}
          frustumCulled={false}
          key={`fdm-cuboids-wire-${model.count}`}
          ref={wireframeRef}
          renderOrder={wireframePolicy.renderOrder}
        />
      ) : null}
      {settings.vectorsVisible ? (
        <VectorFieldLayer
          colors={colors}
          colorMode={vectorColorModeFromSettings(settings, vectorColorMode)}
          materialProfile={materialProfile.glyphs}
          opacity={opacityFromSettings(settings)}
          segments={vectorSegments}
          style={vectorStyleFromSettings(settings, vectorStyle)}
          tracker={tracker}
        />
      ) : null}
    </group>
  );
});
