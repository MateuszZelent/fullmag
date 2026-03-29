"use client";

import { memo, useRef, useEffect, useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { applyMagnetizationHsl } from "../magnetizationColor";
import type { QualityLevel, RenderMode, VoxelColorMode, VoxelSampling, TopoComponent } from "../MagnetizationView3D";

/* ── Types ─────────────────────────────────────────────────────────── */

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

const COMP_NEGATIVE = new THREE.Color("#2f6caa");
const COMP_NEUTRAL = new THREE.Color("#f4f1ed");
const COMP_POSITIVE = new THREE.Color("#cf6256");

const _dummy = new THREE.Object3D();
const _defaultUp = new THREE.Vector3(0, 1, 0);
const _tempVec = new THREE.Vector3();
const _tempPos = new THREE.Vector3();
const _tempScale = new THREE.Vector3();
const _tempQuat = new THREE.Quaternion();
const _tempMatrix = new THREE.Matrix4();
const _color = new THREE.Color();

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

function createArrowGeometry(segments: number): THREE.BufferGeometry {
  const shaft = new THREE.CylinderGeometry(0.05, 0.05, 0.55, segments);
  shaft.translate(0, -0.06, 0);
  const head = new THREE.ConeGeometry(0.2, 0.4, segments);
  head.translate(0, 0.4, 0);
  const merged = mergeGeometries([shaft, head]);
  if (!merged) throw new Error("failed to merge arrow geometry");
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

function writeHiddenMatrix(matrices: Float32Array, offset: number) {
  writeScaleTranslateMatrix(matrices, offset, 0, 0, 0, 0, 0, 0);
}

/* ── Component ─────────────────────────────────────────────────────── */

function FdmInstances({
  grid,
  vectors,
  geometryMode,
  activeMask,
  settings,
  onVisibleCount,
}: FdmInstancesProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const [nx, ny, nz] = grid;
  const count = nx * ny * nz;
  const mode = settings.renderMode;

  /* ── Geometry (memoized per quality + mode) ───────────────────── */
  const geometry = useMemo(() => {
    const cfg = QUALITY_CONFIGS[settings.quality];
    return mode === "voxel" ? createVoxelGeometry() : createArrowGeometry(cfg.segments);
  }, [mode, settings.quality]);

  /* ── Material (memoized per mode + quality + opacity) ─────────── */
  const material = useMemo(() => {
    const cfg = QUALITY_CONFIGS[settings.quality];
    if (mode === "voxel") {
      return cfg.useLighting
        ? new THREE.MeshPhongMaterial({
            transparent: true,
            opacity: settings.voxelOpacity,
            depthWrite: false,
            shininess: 24,
            specular: new THREE.Color(0x24334c),
          })
        : new THREE.MeshBasicMaterial({
            transparent: true,
            opacity: settings.voxelOpacity,
            depthWrite: false,
          });
    }
    return cfg.useLighting
      ? new THREE.MeshPhongMaterial({ shininess: 60, specular: new THREE.Color(0x444444) })
      : new THREE.MeshBasicMaterial();
  }, [mode, settings.quality, settings.voxelOpacity]);

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
    const mesh = meshRef.current;
    if (!mesh) return;
    const instanceColor = mesh.instanceColor;
    if (!instanceColor) return;
    const colors = instanceColor.array as Float32Array;
    const matrices = mesh.instanceMatrix.array as Float32Array;

    const expectedVectorCount = nx * ny * nz * 3;
    const hasVectors = vectors && vectors.length >= expectedVectorCount;

    if (!hasVectors && !geometryMode) {
      mesh.count = 0;
      mesh.instanceMatrix.needsUpdate = true;
      instanceColor.needsUpdate = true;
      onVisibleCount?.(0);
      return;
    }

    mesh.count = count;

    if (!hasVectors && geometryMode) {
      // Geometry-only mode: steel-gray voxels
      const gapScale = Math.max(0.12, 1 - settings.voxelGap);
      let visible = 0;
      let idx = 0;
      for (let iz = 0; iz < nz; iz++) {
        for (let iy = 0; iy < ny; iy++) {
          for (let ix = 0; ix < nx; ix++) {
            const isActive = !activeMask || activeMask[idx];
            if (!isActive) {
              writeHiddenMatrix(matrices, idx * 16);
            } else {
              visible++;
              const depthS = nz > 1 ? gapScale : Math.max(0.22, gapScale * 0.42);
              writeScaleTranslateMatrix(
                matrices,
                idx * 16,
                ix,
                iz,
                iy,
                gapScale,
                depthS,
                gapScale,
              );
            }
            _color.setHSL(210 / 360, 0.08, 0.55);
            colors[idx * 3 + 0] = _color.r;
            colors[idx * 3 + 1] = _color.g;
            colors[idx * 3 + 2] = _color.b;
            idx++;
          }
        }
      }
      onVisibleCount?.(visible);
      mesh.instanceMatrix.needsUpdate = true;
      instanceColor.needsUpdate = true;
      if (!Array.isArray(mesh.material)) {
        (mesh.material as THREE.MeshPhongMaterial | THREE.MeshBasicMaterial).opacity = 0.85;
        mesh.material.needsUpdate = true;
      }
      return;
    }

    // Full field rendering (glyph or voxel)
    const {
      sampling,
      voxelColorMode,
      voxelGap,
      voxelThreshold,
      topoEnabled,
      topoComponent,
      topoMultiplier,
    } = settings;
    const isVoxel = mode === "voxel";
    const step = sampling;
    const baseScale = isVoxel ? Math.max(0.12, step * (1 - voxelGap)) : 1;
    const depthScale = nz > 1 ? baseScale : Math.max(0.22, baseScale * 0.42);

    let maxMagnitude = 0;
    if (isVoxel) {
      for (let i = 0; i < vectors!.length; i += 3) {
        const mx = vectors![i];
        const my = vectors![i + 1];
        const mz = vectors![i + 2];
        maxMagnitude = Math.max(maxMagnitude, Math.sqrt(mx * mx + my * my + mz * mz));
      }
    }
    const normMag = Math.max(maxMagnitude, 1e-30);

    let visible = 0;
    let idx = 0;

    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          const base = idx * 3;
          const mx = vectors![base];
          const my = vectors![base + 1];
          const mz = vectors![base + 2];

          const sampled =
            step === 1 ||
            (ix % step === 0 && iy % step === 0 && (nz <= 1 || iz % step === 0));

          const mag = Math.sqrt(mx * mx + my * my + mz * mz);
          const normalizedStrength = Math.min(1, mag / normMag);
          const strengthScale = 0.18 + 0.82 * Math.sqrt(normalizedStrength);

          if (isVoxel) {
            const cellActive = !activeMask || activeMask[idx];
            const metric =
              voxelColorMode === "orientation"
                ? mag
                : Math.abs(componentValue(mx, my, mz, voxelColorMode as "x" | "y" | "z"));
            const isVisible = cellActive && sampled && metric >= voxelThreshold;

            let worldY = iz;
            let vH = depthScale * strengthScale;
            const voxelScale = baseScale * strengthScale;

            if (topoEnabled && isVisible) {
              const compVal = componentValue(mx, my, mz, topoComponent);
              const displacement = compVal * topoMultiplier;
              const topo = resolveVoxelTopography(iz, vH, displacement);
              worldY = topo.centerZ;
              vH = topo.depthScale;
            }

            if (!isVisible) {
              writeHiddenMatrix(matrices, idx * 16);
            } else {
              visible++;
              writeScaleTranslateMatrix(
                matrices,
                idx * 16,
                ix,
                worldY,
                iy,
                voxelScale,
                vH,
                voxelScale,
              );
            }

            applyVoxelColor(mx, my, mz, voxelColorMode, _color);
          } else {
            const cellActive = !activeMask || activeMask[idx];
            const isVisible = cellActive && (mx !== 0 || my !== 0 || mz !== 0) && sampled;

            if (!isVisible) {
              writeHiddenMatrix(matrices, idx * 16);
            } else {
              visible++;
              _tempPos.set(ix, iz, iy);
              _tempScale.set(1, 1, 1);
              _tempVec.set(mx, mz, my);
              if (_tempVec.lengthSq() > 1e-30) {
                _tempVec.normalize();
              } else {
                _tempVec.set(0, 1, 0);
              }
              _tempQuat.setFromUnitVectors(_defaultUp, _tempVec);
              _tempMatrix.compose(_tempPos, _tempQuat, _tempScale);
              _tempMatrix.toArray(matrices, idx * 16);
            }

            applyMagnetizationHsl(mx, my, mz, _color);
          }

          colors[idx * 3 + 0] = _color.r;
          colors[idx * 3 + 1] = _color.g;
          colors[idx * 3 + 2] = _color.b;
          idx++;
        }
      }
    }

    onVisibleCount?.(visible);
    mesh.instanceMatrix.needsUpdate = true;
    instanceColor.needsUpdate = true;

    if (isVoxel && !Array.isArray(mesh.material)) {
      (mesh.material as THREE.MeshPhongMaterial | THREE.MeshBasicMaterial).opacity = settings.voxelOpacity;
      mesh.material.needsUpdate = true;
    }
  }, [vectors, grid, settings, geometryMode, activeMask, mode, count, nx, ny, nz, onVisibleCount]);

  if (count === 0) {
    if (typeof window !== "undefined") {
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
