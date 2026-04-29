"use client";

import { memo, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { applyMagnetizationHsl } from "../magnetizationColor";
import { COMP_NEGATIVE, COMP_NEUTRAL, COMP_POSITIVE } from "./colorUtils";
import type {
  VectorSurfaceViewportQualityLevel as QualityLevel,
  VectorSurfaceViewportRenderMode as RenderMode,
  VectorSurfaceViewportTopoComponent as TopoComponent,
  VectorSurfaceViewportVoxelColorMode as VoxelColorMode,
  VectorSurfaceViewportVoxelSampling as VoxelSampling,
} from "../fdm/fdmViewportSettingsTypes";
import { recordFrontendPerfSample } from "@/lib/debug/frontendPerfDebug";
import { useBatchedInvalidate } from "./useBatchedInvalidate";

/* ── Types ─────────────────────────────────────────────────────────── */

/** Grid-index bounding box for isolate masking (inclusive float bounds). */
export interface IsolateGridBounds {
  minIx: number; maxIx: number;
  minIy: number; maxIy: number;
  minIz: number; maxIz: number;
}

export interface ResolvedFdmGridBounds {
  minIx: number; maxIx: number;
  minIy: number; maxIy: number;
  minIz: number; maxIz: number;
  empty: boolean;
}

interface FdmInstancesProps {
  grid: [number, number, number];
  vectors: Float64Array | null;
  geometryMode: boolean;
  activeMask: boolean[] | null;
  settings: {
    quality: QualityLevel;
    renderMode: RenderMode;
    voxelColorMode: VoxelColorMode;
    sampling: VoxelSampling;
    voxelOpacity: number;
    voxelGap: number;
    voxelThreshold: number;
    topoEnabled: boolean;
    topoComponent: TopoComponent;
    topoMultiplier: number;
  };
  sceneOpacityMultiplier?: number;
  /** When set, only voxels within these grid-index bounds are rendered. */
  isolateGridBounds?: IsolateGridBounds | null;
  /** When false, clears all instances without re-uploading geometry (toolbar toggle). */
  vectorsVisible?: boolean;
  onVisibleCount?: (count: number) => void;
}

/* ── Quality configs ───────────────────────────────────────────────── */

interface QualityConfig {
  segments: number;
  useLighting: boolean;
  antialias: boolean;
}

const QUALITY_CONFIGS: Record<QualityLevel, QualityConfig> = {
  low: { segments: 6, useLighting: false, antialias: false },
  high: { segments: 12, useLighting: true, antialias: true },
  ultra: { segments: 16, useLighting: true, antialias: true },
};

/* ── Constants ─────────────────────────────────────────────────────── */

const _defaultUp = new THREE.Vector3(0, 1, 0);
const _tempVec = new THREE.Vector3();
const _tempPos = new THREE.Vector3();
const _tempScale = new THREE.Vector3();
const _tempQuat = new THREE.Quaternion();
const _tempMatrix = new THREE.Matrix4();
const _color = new THREE.Color();

export function resolveFdmMaterialOpacity({
  mode,
  voxelOpacity,
  sceneOpacityMultiplier,
  geometryPreviewOpacity = null,
}: {
  mode: RenderMode;
  voxelOpacity: number;
  sceneOpacityMultiplier: number;
  geometryPreviewOpacity?: number | null;
}) {
  const baseOpacity =
    geometryPreviewOpacity ?? (mode === "voxel" ? voxelOpacity : 1);
  const effectiveOpacity = baseOpacity * sceneOpacityMultiplier;
  return {
    effectiveOpacity,
    transparent: effectiveOpacity < 0.999,
  };
}

export function resolveFdmGridBounds(
  grid: [number, number, number],
  isolateGridBounds: IsolateGridBounds | null | undefined,
): ResolvedFdmGridBounds {
  const [nx, ny, nz] = grid;
  const minIx = Math.max(0, Math.floor(isolateGridBounds?.minIx ?? 0));
  const maxIx = Math.min(nx - 1, Math.ceil(isolateGridBounds?.maxIx ?? nx - 1));
  const minIy = Math.max(0, Math.floor(isolateGridBounds?.minIy ?? 0));
  const maxIy = Math.min(ny - 1, Math.ceil(isolateGridBounds?.maxIy ?? ny - 1));
  const minIz = Math.max(0, Math.floor(isolateGridBounds?.minIz ?? 0));
  const maxIz = Math.min(nz - 1, Math.ceil(isolateGridBounds?.maxIz ?? nz - 1));
  return {
    minIx,
    maxIx,
    minIy,
    maxIy,
    minIz,
    maxIz,
    empty: minIx > maxIx || minIy > maxIy || minIz > maxIz,
  };
}

/* ── Color helpers ─────────────────────────────────────────────────── */

function applyComponentColor(value: number, color: THREE.Color) {
  const normalized = THREE.MathUtils.clamp(value, -1, 1);
  if (normalized < 0) {
    color.copy(COMP_NEUTRAL).lerp(COMP_NEGATIVE, Math.abs(normalized));
  } else {
    color.copy(COMP_NEUTRAL).lerp(COMP_POSITIVE, normalized);
  }
}

function componentValue(mx: number, my: number, mz: number, mode: "x" | "y" | "z"): number {
  switch (mode) {
    case "x": return mx;
    case "y": return my;
    case "z": return mz;
  }
}

function applyVoxelColor(mx: number, my: number, mz: number, mode: VoxelColorMode, color: THREE.Color) {
  if (mode === "orientation") {
    applyMagnetizationHsl(mx, my, mz, color);
  } else {
    applyComponentColor(componentValue(mx, my, mz, mode), color);
  }
}

/* ── Topography ────────────────────────────────────────────────────── */

const TOPO_EPSILON = 1e-6;

function resolveVoxelTopography(baseZ: number, baseDepth: number, signedDisplacement: number) {
  if (!Number.isFinite(signedDisplacement) || Math.abs(signedDisplacement) < TOPO_EPSILON) {
    return { centerZ: baseZ, depthScale: baseDepth };
  }
  return {
    centerZ: baseZ + signedDisplacement / 2,
    depthScale: baseDepth + Math.abs(signedDisplacement),
  };
}

/* ── Geometry builders ─────────────────────────────────────────────── */

const ARROW_SHAFT_RADIUS = 0.05;
const ARROW_SHAFT_LENGTH = 0.55;
const ARROW_HEAD_RADIUS = 0.2;
const ARROW_HEAD_LENGTH = 0.4;

/** Magnitude values below this are treated as zero vectors. */
const ZERO_VEC_EPSILON = 1e-30;

/** Strength-to-scale mapping: ensures even weak cells are visible. */
const STRENGTH_SCALE_MIN = 0.18;
const STRENGTH_SCALE_RANGE = 0.82;

/** Glyph strength-to-scale mapping (slightly different visual curve). */
const GLYPH_SCALE_MIN = 0.2;
const GLYPH_SCALE_RANGE = 0.8;

function createArrowGeometry(segments: number): THREE.BufferGeometry {
  const totalLength = ARROW_SHAFT_LENGTH + ARROW_HEAD_LENGTH;
  const shaft = new THREE.CylinderGeometry(ARROW_SHAFT_RADIUS, ARROW_SHAFT_RADIUS, ARROW_SHAFT_LENGTH, segments);
  shaft.translate(0, ARROW_SHAFT_LENGTH / 2, 0);
  const head = new THREE.ConeGeometry(ARROW_HEAD_RADIUS, ARROW_HEAD_LENGTH, segments);
  head.translate(0, ARROW_SHAFT_LENGTH + ARROW_HEAD_LENGTH / 2, 0);
  const merged = mergeGeometries([shaft, head]);
  if (!merged) throw new Error("failed to merge arrow geometry");
  // Center the glyph on the sampled cell instead of anchoring the tail there.
  merged.translate(0, -totalLength / 2, 0);
  merged.computeVertexNormals();
  return merged;
}

function createVoxelGeometry(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(1, 1, 1);
}

function writeScaleTranslateMatrix(
  matrices: Float32Array,
  offset: number,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
) {
  matrices[offset + 0] = sx;
  matrices[offset + 1] = 0;
  matrices[offset + 2] = 0;
  matrices[offset + 3] = 0;
  matrices[offset + 4] = 0;
  matrices[offset + 5] = sy;
  matrices[offset + 6] = 0;
  matrices[offset + 7] = 0;
  matrices[offset + 8] = 0;
  matrices[offset + 9] = 0;
  matrices[offset + 10] = sz;
  matrices[offset + 11] = 0;
  matrices[offset + 12] = x;
  matrices[offset + 13] = y;
  matrices[offset + 14] = z;
  matrices[offset + 15] = 1;
}

/* ── Component ─────────────────────────────────────────────────────── */

function FdmInstances({
  grid,
  vectors,
  geometryMode,
  activeMask,
  settings,
  sceneOpacityMultiplier = 1,
  isolateGridBounds,
  vectorsVisible = true,
  onVisibleCount,
}: FdmInstancesProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const displayToCellRef = useRef<Uint32Array | null>(null);
  const scheduleInvalidate = useBatchedInvalidate();
  const [nx, ny, nz] = grid;
  const count = nx * ny * nz;
  const {
    quality,
    renderMode: mode,
    sampling,
    voxelColorMode,
    voxelOpacity,
    voxelGap,
    voxelThreshold,
    topoEnabled,
    topoComponent,
    topoMultiplier,
  } = settings;
  const expectedVectorCount = nx * ny * nz * 3;
  const hasRenderableVectors = Boolean(vectors && vectors.length >= expectedVectorCount);
  const gridBounds = useMemo(
    () => resolveFdmGridBounds([nx, ny, nz], isolateGridBounds),
    [
      isolateGridBounds?.maxIx,
      isolateGridBounds?.maxIy,
      isolateGridBounds?.maxIz,
      isolateGridBounds?.minIx,
      isolateGridBounds?.minIy,
      isolateGridBounds?.minIz,
      nx,
      ny,
      nz,
    ],
  );

  /* ── Geometry (memoized per quality + mode) ───────────────────── */
  const geometry = useMemo(() => {
    const cfg = QUALITY_CONFIGS[quality];
    return mode === "voxel" ? createVoxelGeometry() : createArrowGeometry(cfg.segments);
  }, [mode, quality]);

  /* ── Material (memoized per mode + quality) ───────────────────── */
  const material = useMemo(() => {
    const cfg = QUALITY_CONFIGS[quality];
    if (mode === "voxel") {
      return cfg.useLighting
        ? new THREE.MeshPhongMaterial({
            side: THREE.FrontSide,
            transparent: false,
            opacity: 1,
            depthWrite: true,
            shininess: 24,
            specular: new THREE.Color(0x24334c),
          })
        : new THREE.MeshBasicMaterial({
            side: THREE.FrontSide,
            transparent: false,
            opacity: 1,
            depthWrite: true,
          });
    }
    return cfg.useLighting
      ? new THREE.MeshPhongMaterial({
          side: THREE.FrontSide,
          shininess: 60,
          specular: new THREE.Color(0x444444),
          transparent: false,
          opacity: 1,
          depthWrite: true,
        })
      : new THREE.MeshBasicMaterial({
          side: THREE.FrontSide,
          transparent: false,
          opacity: 1,
          depthWrite: true,
        });
  }, [mode, quality]);

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    const materials = mesh
      ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material])
      : [material];
    const { effectiveOpacity, transparent } = resolveFdmMaterialOpacity({
      mode,
      voxelOpacity,
      sceneOpacityMultiplier,
      geometryPreviewOpacity: geometryMode && !hasRenderableVectors ? 0.85 : null,
    });
    for (const currentMaterial of materials) {
      if (
        currentMaterial instanceof THREE.MeshPhongMaterial ||
        currentMaterial instanceof THREE.MeshBasicMaterial
      ) {
        currentMaterial.opacity = effectiveOpacity;
        currentMaterial.transparent = transparent;
        currentMaterial.depthWrite = true;
        currentMaterial.needsUpdate = true;
      }
    }
    scheduleInvalidate();
  }, [
    geometryMode,
    hasRenderableVectors,
    material,
    mode,
    scheduleInvalidate,
    sceneOpacityMultiplier,
    voxelOpacity,
  ]);

  /* ── Initialize instanceColor on mount ────────────────────────── */
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh || count === 0) return;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(Math.max(count, 1) * 3),
      3,
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.renderOrder = mode === "voxel" ? 2 : 1;
  }, [count, mode]);

  /* ── Update instances (core rendering loop) ───────────────────── */
  useEffect(() => {
    const start = typeof performance !== "undefined" ? performance.now() : Date.now();
    const mesh = meshRef.current;
    if (!mesh) return;
    const instanceColor = mesh.instanceColor;
    if (!instanceColor) return;

    // Toolbar "vectors off" — clear instances without rebuilding geometry.
    if (!vectorsVisible) {
      mesh.count = 0;
      mesh.instanceMatrix.needsUpdate = true;
      instanceColor.needsUpdate = true;
      onVisibleCount?.(0);
      scheduleInvalidate();
      return;
    }

    const colors = instanceColor.array as Float32Array;
    const matrices = mesh.instanceMatrix.array as Float32Array;

    if (!displayToCellRef.current || displayToCellRef.current.length < count) {
      displayToCellRef.current = new Uint32Array(count);
    }
    const displayToCell = displayToCellRef.current;

    const hasVectors = hasRenderableVectors;

    const { minIx, maxIx, minIy, maxIy, minIz, maxIz } = gridBounds;

    if (gridBounds.empty) {
      mesh.count = 0;
      mesh.instanceMatrix.needsUpdate = true;
      instanceColor.needsUpdate = true;
      onVisibleCount?.(0);
      scheduleInvalidate();
      const timestampMs = typeof performance !== "undefined" ? performance.now() : Date.now();
      recordFrontendPerfSample({
        scope: "FdmInstances",
        phase: "update",
        durationMs: timestampMs - start,
        timestampMs,
        meta: {
          visible: 0,
          mode,
          quality,
        },
      });
      return;
    }

    if (!hasVectors && !geometryMode) {
      mesh.count = 0;
      mesh.instanceMatrix.needsUpdate = true;
      instanceColor.needsUpdate = true;
      onVisibleCount?.(0);
      scheduleInvalidate();
      const timestampMs = typeof performance !== "undefined" ? performance.now() : Date.now();
      recordFrontendPerfSample({
        scope: "FdmInstances",
        phase: "update",
        durationMs: timestampMs - start,
        timestampMs,
        meta: {
          visible: 0,
          mode,
          quality,
        },
      });
      return;
    }

    if (!hasVectors && geometryMode) {
      const gapScale = Math.max(0.12, 1 - voxelGap);
      const depthS = nz > 1 ? gapScale : Math.max(0.22, gapScale * 0.42);
      _color.setHSL(210 / 360, 0.08, 0.55);
      let visible = 0;
      for (let iz = minIz; iz <= maxIz; iz += 1) {
        const zStride = iz * nx * ny;
        for (let iy = minIy; iy <= maxIy; iy += 1) {
          const yStride = iy * nx;
          for (let ix = minIx; ix <= maxIx; ix += 1) {
            const cellIndex = zStride + yStride + ix;
            if (activeMask && !activeMask[cellIndex]) {
              continue;
            }
            const outBaseMatrix = visible * 16;
            const outBaseColor = visible * 3;
            writeScaleTranslateMatrix(
              matrices,
              outBaseMatrix,
              ix,
              iz,
              iy,
              gapScale,
              depthS,
              gapScale,
            );
            colors[outBaseColor] = _color.r;
            colors[outBaseColor + 1] = _color.g;
            colors[outBaseColor + 2] = _color.b;
            displayToCell[visible] = cellIndex;
            visible += 1;
          }
        }
      }
      mesh.count = visible;
      onVisibleCount?.(visible);
      mesh.instanceMatrix.needsUpdate = true;
      instanceColor.needsUpdate = true;
      scheduleInvalidate();
      const timestampMs = typeof performance !== "undefined" ? performance.now() : Date.now();
      recordFrontendPerfSample({
        scope: "FdmInstances",
        phase: "update",
        durationMs: timestampMs - start,
        timestampMs,
        meta: {
          visible,
          mode,
          quality,
        },
      });
      return;
    }

    const isVoxel = mode === "voxel";
    const step = sampling;
    const baseScale = isVoxel ? Math.max(0.12, step * (1 - voxelGap)) : 1;
    const depthScale = nz > 1 ? baseScale : Math.max(0.22, baseScale * 0.42);

    let maxMagnitude = 0;
    for (let i = 0; i < vectors!.length; i += 3) {
      const mx = vectors![i];
      const my = vectors![i + 1];
      const mz = vectors![i + 2];
      maxMagnitude = Math.max(maxMagnitude, Math.sqrt(mx * mx + my * my + mz * mz));
    }
    const normMag = Math.max(maxMagnitude, ZERO_VEC_EPSILON);

    const startIx = step === 1 ? minIx : minIx + ((step - (minIx % step)) % step);
    const startIy = step === 1 ? minIy : minIy + ((step - (minIy % step)) % step);
    const startIz = step === 1 || nz <= 1 ? minIz : minIz + ((step - (minIz % step)) % step);

    let visible = 0;
    for (let iz = startIz; iz <= maxIz; iz += nz <= 1 ? 1 : step) {
      const zStride = iz * nx * ny;
      for (let iy = startIy; iy <= maxIy; iy += step) {
        const yStride = iy * nx;
        for (let ix = startIx; ix <= maxIx; ix += step) {
          const cellIndex = zStride + yStride + ix;
          if (activeMask && !activeMask[cellIndex]) {
            continue;
          }
          const base = cellIndex * 3;
          const mx = vectors![base];
          const my = vectors![base + 1];
          const mz = vectors![base + 2];
          const mag = Math.sqrt(mx * mx + my * my + mz * mz);
          if (isVoxel && mag < voxelThreshold) {
            continue;
          }
          if (!isVoxel && mx === 0 && my === 0 && mz === 0) {
            continue;
          }

          const outBaseMatrix = visible * 16;
          const outBaseColor = visible * 3;
          const normalizedStrength = Math.min(1, mag / normMag);
          const strengthScale = STRENGTH_SCALE_MIN + STRENGTH_SCALE_RANGE * Math.sqrt(normalizedStrength);

          if (isVoxel) {
            let worldY = iz;
            let vH = depthScale * strengthScale;
            const voxelScale = baseScale * strengthScale;
            if (topoEnabled) {
              const compVal = componentValue(mx, my, mz, topoComponent);
              const displacement = compVal * topoMultiplier;
              const topo = resolveVoxelTopography(iz, vH, displacement);
              worldY = topo.centerZ;
              vH = topo.depthScale;
            }
            writeScaleTranslateMatrix(
              matrices,
              outBaseMatrix,
              ix,
              worldY,
              iy,
              voxelScale,
              vH,
              voxelScale,
            );
            applyVoxelColor(mx, my, mz, voxelColorMode, _color);
          } else {
            _tempPos.set(ix, iz, iy);
            const glyphScale = GLYPH_SCALE_MIN + GLYPH_SCALE_RANGE * Math.sqrt(Math.min(1, mag / normMag));
            _tempScale.set(glyphScale, glyphScale, glyphScale);
            _tempVec.set(mx, mz, my);
            if (_tempVec.lengthSq() > ZERO_VEC_EPSILON) {
              _tempVec.normalize();
            } else {
              _tempVec.set(0, 1, 0);
            }
            _tempQuat.setFromUnitVectors(_defaultUp, _tempVec);
            _tempMatrix.compose(_tempPos, _tempQuat, _tempScale);
            _tempMatrix.toArray(matrices, outBaseMatrix);
            applyMagnetizationHsl(mx, my, mz, _color);
          }

          colors[outBaseColor] = _color.r;
          colors[outBaseColor + 1] = _color.g;
          colors[outBaseColor + 2] = _color.b;
          displayToCell[visible] = cellIndex;
          visible += 1;
        }
      }
    }

    mesh.count = visible;
    onVisibleCount?.(visible);
    mesh.instanceMatrix.needsUpdate = true;
    instanceColor.needsUpdate = true;

    scheduleInvalidate();
    const timestampMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    recordFrontendPerfSample({
      scope: "FdmInstances",
      phase: "update",
      durationMs: timestampMs - start,
      timestampMs,
      meta: {
        visible,
        mode,
        quality,
      },
    });
  }, [
    activeMask,
    count,
    geometryMode,
    hasRenderableVectors,
    gridBounds,
    mode,
    nx,
    ny,
    nz,
    onVisibleCount,
    quality,
    sampling,
    scheduleInvalidate,
    topoComponent,
    topoEnabled,
    topoMultiplier,
    vectors,
    vectorsVisible,
    voxelColorMode,
    voxelGap,
    voxelThreshold,
  ]);

  if (count === 0) {
    if (typeof process !== "undefined" && process.env.NODE_ENV === "development") {
      console.warn("[FdmInstances] count=0 — grid is", grid, "— no instances will render");
    }
    return null;
  }

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, count]}
    />
  );
}

export default memo(FdmInstances);
