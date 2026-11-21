"use client";

import type { ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  Plane,
  Vector3,
  type Ray,
} from "three";

import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import type { TargetMetricBounds, Vec3 } from "@/shared/domain/magnetization-texture/boundsResolver";
import { resolveTargetBoundsMeters } from "@/shared/domain/magnetization-texture/boundsResolver";
import {
  axisAngleToQuaternion,
  multiplyQuaternions,
  normalizeQuaternion,
  quaternionToEulerDegrees,
  rotateVectorByQuaternion,
  type Quat4,
} from "@/shared/domain/magnetization-texture/evaluateV2Client";
import {
  hydrateMagneticTextureDraftFromInitializer,
  type MagneticTextureDraft,
} from "@/shared/domain/magnetization-texture/presetDefaults";
import {
  beginTextureGizmoGesture,
  endTextureGizmoGesture,
  getTextureDraftBridgeSnapshot,
  handleTextureGizmoShortcutKey,
  patchActiveTextureDraft,
  subscribeTextureDraftBridge,
  type TextureGizmoMode,
} from "@/shared/domain/magnetization-texture/textureDraftBridge";
import { canonicalPresetKind } from "@/shared/domain/magnetization-texture/texturePresets";

import { useViewport3DColors } from "./hooks/useViewport3DColors";
import { RENDER_POLICIES } from "./layers/viewport3DRenderPolicy";
import { useBatchedInvalidate } from "./viewport3dBatchedInvalidate";
import type { Viewport3DResourceTracker } from "./viewport3dDiagnostics";
import {
  sampleViewport3DSurfaceHslColors,
  type Viewport3DPrimitiveObject,
  type Viewport3DPrimitiveRenderModel,
} from "./viewport3dPrimitiveModel";

export type GizmoAxis = "x" | "y" | "z";
export type GizmoPlane = "xy" | "xz" | "yz";
export type TranslateHandleId = GizmoAxis | GizmoPlane;
export type ScaleHandleId = GizmoAxis | "uniform";

const SNAP_TRANSLATION_STEP_M = 1e-9; // 1 nm metric snap when Shift is held
const SNAP_ROTATION_DEG = 15; // 15° angular snap when Shift is held
const MIN_SCALE_FACTOR = 1e-3;
const MAX_SCALE_FACTOR = 1e3;
const SURFACE_PREVIEW_GRID_RES = 32;

export interface TextureGizmoWorldPose {
  readonly originWorld: Vec3;
  readonly pivotWorld: Vec3;
  readonly rotationQuat: Quat4;
  readonly handleLength: number;
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as {
    tagName?: string;
    isContentEditable?: boolean;
    getAttribute?: (attr: string) => string | null;
  };
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  if (el.getAttribute?.("contenteditable") === "true") return true;
  return false;
}

export function installTextureGizmoKeyboardShortcuts(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
): () => void {
  const onKeyDown = (rawEvent: Event) => {
    const event = rawEvent as KeyboardEvent;
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (isEditableKeyboardTarget(event.target)) return;
    if (handleTextureGizmoShortcutKey(event.key)) {
      event.preventDefault();
    }
  };
  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}

export function resolveTextureGizmoWorldPose(
  draft: MagneticTextureDraft,
  targetBounds: TargetMetricBounds,
): TextureGizmoWorldPose {
  const spaceOrigin: Vec3 =
    draft.mappingSpace === "world" ? [0, 0, 0] : targetBounds.worldCenter;
  const pivotLocal: Vec3 =
    draft.pivotMode === "custom" ? draft.pivotM : [0, 0, 0];
  const pivotWorld: Vec3 = [
    spaceOrigin[0] + pivotLocal[0],
    spaceOrigin[1] + pivotLocal[1],
    spaceOrigin[2] + pivotLocal[2],
  ];
  const originWorld: Vec3 = [
    pivotWorld[0] + draft.translationM[0],
    pivotWorld[1] + draft.translationM[1],
    pivotWorld[2] + draft.translationM[2],
  ];
  const maxSpan = Math.max(
    targetBounds.size[0],
    targetBounds.size[1],
    targetBounds.size[2],
    1e-12,
  );
  return {
    originWorld,
    pivotWorld,
    rotationQuat: normalizeQuaternion(draft.rotationQuat),
    handleLength: maxSpan * 0.55,
  };
}

export function snapTranslationMeters(value: number, shiftKey: boolean): number {
  if (!shiftKey) return value;
  return Math.round(value / SNAP_TRANSLATION_STEP_M) * SNAP_TRANSLATION_STEP_M;
}

export function applyTextureGizmoTranslateDrag(
  startTranslationM: Vec3,
  deltaWorld: Vec3,
  handle: TranslateHandleId,
  shiftKey: boolean,
): Vec3 {
  const dx =
    handle === "x" || handle === "xy" || handle === "xz" ? deltaWorld[0] : 0;
  const dy =
    handle === "y" || handle === "xy" || handle === "yz" ? deltaWorld[1] : 0;
  const dz =
    handle === "z" || handle === "xz" || handle === "yz" ? deltaWorld[2] : 0;
  return [
    snapTranslationMeters(startTranslationM[0] + dx, shiftKey),
    snapTranslationMeters(startTranslationM[1] + dy, shiftKey),
    snapTranslationMeters(startTranslationM[2] + dz, shiftKey),
  ];
}

export function applyTextureGizmoRotateDrag(
  startQuat: Quat4,
  startEulerDeg: Vec3,
  axis: GizmoAxis,
  deltaRadians: number,
  shiftKey: boolean,
): { rotationQuat: Quat4; eulerDeg: Vec3 } {
  let deltaDeg = (deltaRadians * 180) / Math.PI;
  if (shiftKey) {
    deltaDeg = Math.round(deltaDeg / SNAP_ROTATION_DEG) * SNAP_ROTATION_DEG;
  }
  const axisVec: Vec3 =
    axis === "x" ? [1, 0, 0] : axis === "y" ? [0, 1, 0] : [0, 0, 1];
  const deltaQuat = axisAngleToQuaternion(axisVec, deltaDeg);
  const nextQuat = multiplyQuaternions(deltaQuat, startQuat);
  const nextEuler = quaternionToEulerDegrees(nextQuat, startEulerDeg);
  return {
    rotationQuat: nextQuat,
    eulerDeg: nextEuler,
  };
}

function clampScaleComponent(value: number): number {
  if (!Number.isFinite(value)) return 1;
  const abs = Math.min(MAX_SCALE_FACTOR, Math.max(MIN_SCALE_FACTOR, Math.abs(value)));
  return value < 0 ? -abs : abs;
}

export function applyTextureGizmoScaleDrag(
  startScale: Vec3,
  handle: ScaleHandleId,
  ratio: number,
  uniformLocked: boolean,
  shiftKey: boolean,
): Vec3 {
  const safeRatio = Number.isFinite(ratio) && Math.abs(ratio) > 1e-6 ? ratio : 1;
  if (handle === "uniform" || uniformLocked || shiftKey) {
    return [
      clampScaleComponent(startScale[0] * safeRatio),
      clampScaleComponent(startScale[1] * safeRatio),
      clampScaleComponent(startScale[2] * safeRatio),
    ];
  }
  return [
    handle === "x" ? clampScaleComponent(startScale[0] * safeRatio) : startScale[0],
    handle === "y" ? clampScaleComponent(startScale[1] * safeRatio) : startScale[1],
    handle === "z" ? clampScaleComponent(startScale[2] * safeRatio) : startScale[2],
  ];
}

function pushSegment(out: number[], a: Vec3, b: Vec3): void {
  out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
}

function pushCircleInPlane(
  out: number[],
  plane: "xy" | "xz" | "yz",
  radius: number,
  segments = 48,
  offsetNormal = 0,
): void {
  const r = Math.max(Math.abs(radius), 1e-12);
  for (let i = 0; i < segments; i += 1) {
    const a0 = (2 * Math.PI * i) / segments;
    const a1 = (2 * Math.PI * (i + 1)) / segments;
    const u0 = r * Math.cos(a0);
    const v0 = r * Math.sin(a0);
    const u1 = r * Math.cos(a1);
    const v1 = r * Math.sin(a1);
    if (plane === "xy") {
      pushSegment(out, [u0, v0, offsetNormal], [u1, v1, offsetNormal]);
    } else if (plane === "xz") {
      pushSegment(out, [u0, offsetNormal, v0], [u1, offsetNormal, v1]);
    } else {
      pushSegment(out, [offsetNormal, u0, v0], [offsetNormal, u1, v1]);
    }
  }
}

function pushWireframeBox(out: number[], halfExtents: Vec3): void {
  const [hx, hy, hz] = halfExtents;
  const corners: Vec3[] = [
    [-hx, -hy, -hz],
    [hx, -hy, -hz],
    [hx, hy, -hz],
    [-hx, hy, -hz],
    [-hx, -hy, hz],
    [hx, -hy, hz],
    [hx, hy, hz],
    [-hx, hy, hz],
  ];
  const edges: readonly [number, number][] = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  for (const [i0, i1] of edges) {
    pushSegment(out, corners[i0]!, corners[i1]!);
  }
}

/**
 * Builds local-space (transformed by `scale` and `rotationQuat` around `originWorld`)
 * characteristic proxy wireframe segments for all 20 presets + periodic `tilePeriodM` box.
 */
export function buildCharacteristicProxyWireframeSegments(
  draft: MagneticTextureDraft,
  bounds: TargetMetricBounds,
): Float32Array {
  const raw: number[] = [];
  const kind = canonicalPresetKind(draft.presetKind);
  const plane = draft.resolvedPlane;
  const minSpan = Math.max(Math.min(...bounds.size), 1e-12);
  const maxSpan = Math.max(...bounds.size, 1e-12);

  switch (kind) {
    case "uniform":
    case "random": {
      pushCircleInPlane(raw, plane, minSpan * 0.12, 24);
      break;
    }
    case "vortex":
    case "antivortex": {
      pushCircleInPlane(raw, plane, draft.coreRadiusM, 48);
      break;
    }
    case "bloch_skyrmion":
    case "neel_skyrmion":
    case "antiskyrmion":
    case "bimeron": {
      pushCircleInPlane(raw, plane, draft.radiusM, 48);
      pushCircleInPlane(raw, plane, draft.radiusM + draft.wallWidthM * 0.5, 32);
      break;
    }
    case "skyrmionium": {
      pushCircleInPlane(raw, plane, draft.innerRadiusM, 48);
      pushCircleInPlane(raw, plane, draft.outerRadiusM, 48);
      break;
    }
    case "skyrmion_lattice": {
      const halfA = Math.max(draft.latticeConstantM * 0.5, 1e-12);
      pushCircleInPlane(raw, plane, draft.radiusM, 36);
      if (plane === "xy") {
        pushWireframeBox(raw, [halfA, halfA, Math.max(bounds.size[2] * 0.5, 1e-12)]);
      } else if (plane === "xz") {
        pushWireframeBox(raw, [halfA, Math.max(bounds.size[1] * 0.5, 1e-12), halfA]);
      } else {
        pushWireframeBox(raw, [Math.max(bounds.size[0] * 0.5, 1e-12), halfA, halfA]);
      }
      break;
    }
    case "artificial_spin_ice": {
      const halfA = Math.max(draft.asiPitchM * 0.5, 1e-12);
      if (plane === "xy") {
        pushWireframeBox(raw, [halfA, halfA, Math.max(bounds.size[2] * 0.5, 1e-12)]);
      } else if (plane === "xz") {
        pushWireframeBox(raw, [halfA, Math.max(bounds.size[1] * 0.5, 1e-12), halfA]);
      } else {
        pushWireframeBox(raw, [Math.max(bounds.size[0] * 0.5, 1e-12), halfA, halfA]);
      }
      break;
    }
    case "domain_wall":
    case "two_domain":
    case "vortex_wall": {
      const axis = kind === "vortex_wall" ? "x" : draft.normalAxis;
      const s0 = kind === "domain_wall" ? draft.centerOffsetM : 0;
      const halfW =
        kind === "vortex_wall"
          ? draft.wallHalfWidthM
          : kind === "two_domain" && draft.twoDomainSharp
            ? 0
            : draft.wallWidthM * 0.5;
      const hx = Math.max(bounds.size[0] * 0.5, 1e-12);
      const hy = Math.max(bounds.size[1] * 0.5, 1e-12);
      const hz = Math.max(bounds.size[2] * 0.5, 1e-12);
      const pushWallSlice = (offset: number) => {
        if (axis === "x") {
          pushSegment(raw, [offset, -hy, -hz], [offset, hy, -hz]);
          pushSegment(raw, [offset, hy, -hz], [offset, hy, hz]);
          pushSegment(raw, [offset, hy, hz], [offset, -hy, hz]);
          pushSegment(raw, [offset, -hy, hz], [offset, -hy, -hz]);
        } else if (axis === "y") {
          pushSegment(raw, [-hx, offset, -hz], [hx, offset, -hz]);
          pushSegment(raw, [hx, offset, -hz], [hx, offset, hz]);
          pushSegment(raw, [hx, offset, hz], [-hx, offset, hz]);
          pushSegment(raw, [-hx, offset, hz], [-hx, offset, -hz]);
        } else {
          pushSegment(raw, [-hx, -hy, offset], [hx, -hy, offset]);
          pushSegment(raw, [hx, -hy, offset], [hx, hy, offset]);
          pushSegment(raw, [hx, hy, offset], [-hx, hy, offset]);
          pushSegment(raw, [-hx, hy, offset], [-hx, -hy, offset]);
        }
      };
      pushWallSlice(s0);
      if (halfW > 1e-14) {
        pushWallSlice(s0 - halfW);
        pushWallSlice(s0 + halfW);
      }
      break;
    }
    case "helical":
    case "conical":
    case "spiral": {
      const q = draft.propagationAxis;
      const qLen = Math.hypot(q[0], q[1], q[2]) || 1;
      const dir: Vec3 = [q[0] / qLen, q[1] / qLen, q[2] / qLen];
      const halfSpan = maxSpan * 0.5;
      pushSegment(
        raw,
        [-dir[0] * halfSpan, -dir[1] * halfSpan, -dir[2] * halfSpan],
        [dir[0] * halfSpan, dir[1] * halfSpan, dir[2] * halfSpan],
      );
      const ref: Vec3 = Math.abs(dir[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      const perp: Vec3 = [
        dir[1] * ref[2] - dir[2] * ref[1],
        dir[2] * ref[0] - dir[0] * ref[2],
        dir[0] * ref[1] - dir[1] * ref[0],
      ];
      const pLen = Math.hypot(perp[0], perp[1], perp[2]) || 1;
      const tickHalf = minSpan * 0.12;
      const tickVec: Vec3 = [
        (perp[0] / pLen) * tickHalf,
        (perp[1] / pLen) * tickHalf,
        (perp[2] / pLen) * tickHalf,
      ];
      const wl = Math.max(draft.wavelengthM, maxSpan * 0.05);
      const maxTicks = 8;
      const count = Math.min(maxTicks, Math.max(1, Math.floor(halfSpan / wl)));
      for (let k = -count; k <= count; k += 1) {
        const s = k * wl;
        const c: Vec3 = [dir[0] * s, dir[1] * s, dir[2] * s];
        pushSegment(
          raw,
          [c[0] - tickVec[0], c[1] - tickVec[1], c[2] - tickVec[2]],
          [c[0] + tickVec[0], c[1] + tickVec[1], c[2] + tickVec[2]],
        );
      }
      break;
    }
    case "hopfion": {
      pushCircleInPlane(raw, "xy", draft.radiusM, 48);
      pushCircleInPlane(raw, "xz", draft.radiusM * 0.5, 32);
      pushCircleInPlane(raw, "yz", draft.radiusM * 0.5, 32);
      break;
    }
    case "hopfion_compact_support": {
      pushCircleInPlane(raw, "xy", draft.majorRadiusM, 48);
      pushCircleInPlane(raw, "xy", Math.max(draft.majorRadiusM - draft.minorRadiusM, 1e-12), 36);
      pushCircleInPlane(raw, "xy", draft.majorRadiusM + draft.minorRadiusM, 36);
      break;
    }
    case "bloch_point": {
      const r = minSpan * 0.25;
      pushCircleInPlane(raw, "xy", r, 36);
      pushCircleInPlane(raw, "xz", r, 36);
      pushCircleInPlane(raw, "yz", r, 36);
      break;
    }
  }

  if (draft.clampMode !== "none") {
    pushWireframeBox(raw, [
      Math.max(Math.abs(draft.tilePeriodM[0]) * 0.5, 1e-12),
      Math.max(Math.abs(draft.tilePeriodM[1]) * 0.5, 1e-12),
      Math.max(Math.abs(draft.tilePeriodM[2]) * 0.5, 1e-12),
    ]);
  }

  // Transform proxy vertices by draft scale + rotationQuat around local origin
  const quat = normalizeQuaternion(draft.rotationQuat);
  const [sx, sy, sz] = draft.scale;
  const out = new Float32Array(raw.length);
  for (let i = 0; i + 2 < raw.length; i += 3) {
    const scaled: Vec3 = [raw[i]! * sx, raw[i + 1]! * sy, raw[i + 2]! * sz];
    const rotated = rotateVectorByQuaternion(scaled, quat);
    out[i] = rotated[0];
    out[i + 1] = rotated[1];
    out[i + 2] = rotated[2];
  }
  return out;
}

/**
 * Generates a subdivided 32×32 surface preview mesh in world coordinates so
 * smooth analytical spin textures (skyrmions, vortices, helices) are crisp even
 * on unmeshed authoring primitives.
 */
export function buildSubdividedSurfacePreviewData(
  object: Viewport3DPrimitiveObject,
  gridRes = SURFACE_PREVIEW_GRID_RES,
): { positionsWorld: Float32Array; indices: Uint32Array } {
  const n = Math.max(4, Math.min(64, Math.floor(gridRes)));
  const [cx, cy, cz] = object.bounds.center;
  const [sx, sy, sz] = object.bounds.size;
  const positions: number[] = [];
  const indices: number[] = [];

  if (object.kind === "cylinder" || object.kind === "cylinder-cylinder-difference") {
    const rx = Math.max(sx * 0.5, 1e-12);
    const ry = Math.max(sy * 0.5, 1e-12);
    const halfZ = sz * 0.5;
    // Top cap polar grid (r × theta) + side mantle
    const rings = Math.max(4, Math.floor(n / 2));
    const segs = n;
    for (const zSign of [1, -1] as const) {
      const baseIdx = positions.length / 3;
      const z = cz + zSign * halfZ;
      for (let ir = 0; ir <= rings; ir += 1) {
        const frac = ir / rings;
        for (let it = 0; it <= segs; it += 1) {
          const theta = (2 * Math.PI * it) / segs;
          positions.push(
            cx + rx * frac * Math.cos(theta),
            cy + ry * frac * Math.sin(theta),
            z,
          );
        }
      }
      const stride = segs + 1;
      for (let ir = 0; ir < rings; ir += 1) {
        for (let it = 0; it < segs; it += 1) {
          const a = baseIdx + ir * stride + it;
          const b = a + 1;
          const c = a + stride;
          const d = c + 1;
          if (zSign > 0) {
            indices.push(a, b, d, a, d, c);
          } else {
            indices.push(a, d, b, a, c, d);
          }
        }
      }
    }
  } else if (object.kind === "sphere") {
    const rx = Math.max(sx * 0.5, 1e-12);
    const ry = Math.max(sy * 0.5, 1e-12);
    const rz = Math.max(sz * 0.5, 1e-12);
    const stacks = Math.max(8, Math.floor(n / 2));
    const slices = n;
    for (let is = 0; is <= stacks; is += 1) {
      const phi = (Math.PI * is) / stacks;
      const sinPhi = Math.sin(phi);
      const cosPhi = Math.cos(phi);
      for (let it = 0; it <= slices; it += 1) {
        const theta = (2 * Math.PI * it) / slices;
        positions.push(
          cx + rx * sinPhi * Math.cos(theta),
          cy + ry * sinPhi * Math.sin(theta),
          cz + rz * cosPhi,
        );
      }
    }
    const stride = slices + 1;
    for (let is = 0; is < stacks; is += 1) {
      for (let it = 0; it < slices; it += 1) {
        const a = is * stride + it;
        const b = a + 1;
        const c = a + stride;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
  } else {
    // Subdivided 6-face box shell (32×32 on primary face, 8×32 on thin side faces)
    const hx = Math.max(sx * 0.5, 1e-12);
    const hy = Math.max(sy * 0.5, 1e-12);
    const hz = Math.max(sz * 0.5, 1e-12);
    const addPatch = (
      origin: Vec3,
      uVec: Vec3,
      vVec: Vec3,
      nu: number,
      nv: number,
    ) => {
      const base = positions.length / 3;
      for (let iv = 0; iv <= nv; iv += 1) {
        const tv = iv / nv;
        for (let iu = 0; iu <= nu; iu += 1) {
          const tu = iu / nu;
          positions.push(
            cx + origin[0] + uVec[0] * tu + vVec[0] * tv,
            cy + origin[1] + uVec[1] * tu + vVec[1] * tv,
            cz + origin[2] + uVec[2] * tu + vVec[2] * tv,
          );
        }
      }
      const stride = nu + 1;
      for (let iv = 0; iv < nv; iv += 1) {
        for (let iu = 0; iu < nu; iu += 1) {
          const a = base + iv * stride + iu;
          const b = a + 1;
          const c = a + stride;
          const d = c + 1;
          indices.push(a, b, d, a, d, c);
        }
      }
    };
    const thinSteps = Math.max(2, Math.min(8, Math.floor(n / 4)));
    // +Z and -Z faces (n × n)
    addPatch([-hx, -hy, hz], [2 * hx, 0, 0], [0, 2 * hy, 0], n, n);
    addPatch([hx, -hy, -hz], [-2 * hx, 0, 0], [0, 2 * hy, 0], n, n);
    // ±Y and ±X faces
    addPatch([-hx, -hy, -hz], [2 * hx, 0, 0], [0, 0, 2 * hz], n, thinSteps);
    addPatch([hx, hy, -hz], [-2 * hx, 0, 0], [0, 0, 2 * hz], n, thinSteps);
    addPatch([hx, -hy, -hz], [0, 2 * hy, 0], [0, 0, 2 * hz], thinSteps, thinSteps);
    addPatch([-hx, hy, -hz], [0, -2 * hy, 0], [0, 0, 2 * hz], thinSteps, thinSteps);
  }

  return {
    positionsWorld: new Float32Array(positions),
    indices: new Uint32Array(indices),
  };
}

interface ActiveDragSession {
  pointerId: number;
  mode: Exclude<TextureGizmoMode, "view">;
  handle: TranslateHandleId | GizmoAxis | ScaleHandleId;
  dragPlane: Plane;
  startPoint: Vec3;
  startTranslationM: Vec3;
  startQuat: Quat4;
  startEulerDeg: Vec3;
  startScale: Vec3;
  uniformLocked: boolean;
  originWorld: Vec3;
  handleLength: number;
  releaseCapture: (pointerId: number) => void;
}

function createGizmoDragStore() {
  let activeSession: ActiveDragSession | null = null;
  return {
    get(): ActiveDragSession | null {
      return activeSession;
    },
    set(next: ActiveDragSession | null): void {
      activeSession = next;
    },
    clear(): boolean {
      if (!activeSession) return false;
      activeSession = null;
      return true;
    },
  };
}

function resolveDragPlaneNormal(
  mode: Exclude<TextureGizmoMode, "view">,
  handle: TranslateHandleId | GizmoAxis | ScaleHandleId,
  rayDirection?: Vector3,
): Vector3 {
  if (mode === "rotate") {
    if (handle === "x") return new Vector3(1, 0, 0);
    if (handle === "y") return new Vector3(0, 1, 0);
    return new Vector3(0, 0, 1);
  }
  if (handle === "xy") return new Vector3(0, 0, 1);
  if (handle === "xz") return new Vector3(0, 1, 0);
  if (handle === "yz") return new Vector3(1, 0, 0);
  if (rayDirection && rayDirection.lengthSq() > 1e-12) {
    return rayDirection.clone().normalize();
  }
  return new Vector3(0, 0, 1);
}

function extractEventPoint(event: ThreeEvent<PointerEvent>, fallback: Vec3): Vec3 {
  const pt = event.point;
  if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y) && Number.isFinite(pt.z)) {
    return [pt.x, pt.y, pt.z];
  }
  return fallback;
}

function intersectRayOrFallback(ray: Ray | undefined, plane: Plane, fallback: Vec3): Vec3 {
  if (ray) {
    const out = new Vector3();
    const hit = ray.intersectPlane(plane, out);
    if (hit) return [hit.x, hit.y, hit.z];
  }
  return fallback;
}

export function Viewport3DTextureTransformLayer({
  onGestureActiveChange,
  primitiveModel,
  selectedObjectId,
  tracker,
}: {
  onGestureActiveChange?: (active: boolean) => void;
  primitiveModel: Viewport3DPrimitiveRenderModel | null;
  selectedObjectId: string | null;
  tracker?: Viewport3DResourceTracker;
}) {
  const bridge = useSyncExternalStore(
    subscribeTextureDraftBridge,
    getTextureDraftBridgeSnapshot,
    getTextureDraftBridgeSnapshot,
  );
  const scene = useSceneResource();
  const { colors } = useViewport3DColors();
  const invalidate = useBatchedInvalidate();
  const dragStore = useMemo(() => createGizmoDragStore(), []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    return installTextureGizmoKeyboardShortcuts(window);
  }, []);

  useEffect(() => {
    onGestureActiveChange?.(bridge.gestureActive);
  }, [bridge.gestureActive, onGestureActiveChange]);

  useEffect(
    () => () => {
      if (dragStore.clear()) {
        endTextureGizmoGesture();
      }
    },
    [dragStore],
  );

  const selectedObject = useMemo(() => {
    if (!selectedObjectId || !primitiveModel?.objects.length) return null;
    return (
      primitiveModel.objects.find((candidate) => candidate.objectId === selectedObjectId) ??
      null
    );
  }, [primitiveModel, selectedObjectId]);

  const bindingMatchesObject = Boolean(
    selectedObject &&
      bridge.activeBinding &&
      bridge.activeBinding.target.objectId === selectedObject.objectId,
  );

  const effectiveDraftAndBounds = useMemo((): {
    draft: MagneticTextureDraft;
    bounds: TargetMetricBounds;
  } | null => {
    if (!selectedObject) return null;
    if (bindingMatchesObject && bridge.activeBinding) {
      return {
        draft: bridge.activeBinding.draft,
        bounds: bridge.activeBinding.bounds,
      };
    }
    if (!bridge.gizmoEnabled || !scene.data) return null;
    const objTarget = { kind: "object" as const, objectId: selectedObject.objectId };
    const bounds = resolveTargetBoundsMeters(scene.data, objTarget);
    const sceneObj = scene.data.objects?.find((entry) => entry.id === selectedObject.objectId);
    const asset = scene.data.magnetization_assets?.find(
      (entry) => entry.id === sceneObj?.magnetization_ref,
    );
    const draft = hydrateMagneticTextureDraftFromInitializer(asset, bounds, "object");
    return { draft, bounds };
  }, [bindingMatchesObject, bridge.activeBinding, bridge.gizmoEnabled, scene.data, selectedObject]);

  const showSurfacePreview = Boolean(
    selectedObject &&
      (bindingMatchesObject || bridge.gizmoEnabled) &&
      effectiveDraftAndBounds?.draft.sourceMode !== "field-file",
  );

  const subdividedMeshData = useMemo(() => {
    if (!selectedObject || !showSurfacePreview) return null;
    return buildSubdividedSurfacePreviewData(selectedObject, SURFACE_PREVIEW_GRID_RES);
  }, [selectedObject, showSurfacePreview]);

  const surfaceColors = useMemo(() => {
    if (!selectedObject || !subdividedMeshData || !showSurfacePreview) return null;
    return sampleViewport3DSurfaceHslColors({
      scene: scene.data ?? null,
      objectId: selectedObject.objectId,
      positionsWorld: subdividedMeshData.positionsWorld,
      liveBinding: bindingMatchesObject ? bridge.activeBinding : null,
    });
  }, [
    bindingMatchesObject,
    bridge.activeBinding,
    scene.data,
    selectedObject,
    showSurfacePreview,
    subdividedMeshData,
  ]);

  const surfaceGeometry = useMemo(() => {
    if (!subdividedMeshData || !surfaceColors) return null;
    const geom = new BufferGeometry();
    geom.setAttribute("position", new BufferAttribute(subdividedMeshData.positionsWorld, 3));
    geom.setAttribute("color", new BufferAttribute(surfaceColors, 3));
    geom.setIndex(new BufferAttribute(subdividedMeshData.indices, 1));
    geom.computeVertexNormals();
    return tracker ? tracker.track("geometry", geom) : geom;
  }, [subdividedMeshData, surfaceColors, tracker]);

  useEffect(() => {
    if (!surfaceGeometry) return undefined;
    invalidate();
    return () => {
      if (tracker) {
        tracker.release("geometry", surfaceGeometry);
      } else {
        surfaceGeometry.dispose();
      }
    };
  }, [invalidate, surfaceGeometry, tracker]);

  const proxySegments = useMemo(() => {
    if (!bridge.gizmoEnabled || !effectiveDraftAndBounds) return null;
    return buildCharacteristicProxyWireframeSegments(
      effectiveDraftAndBounds.draft,
      effectiveDraftAndBounds.bounds,
    );
  }, [bridge.gizmoEnabled, effectiveDraftAndBounds]);

  const proxyGeometry = useMemo(() => {
    if (!proxySegments || proxySegments.length === 0) return null;
    const geom = new BufferGeometry();
    geom.setAttribute("position", new BufferAttribute(proxySegments, 3));
    return tracker ? tracker.track("geometry", geom) : geom;
  }, [proxySegments, tracker]);

  useEffect(() => {
    if (!proxyGeometry) return undefined;
    invalidate();
    return () => {
      if (tracker) {
        tracker.release("geometry", proxyGeometry);
      } else {
        proxyGeometry.dispose();
      }
    };
  }, [invalidate, proxyGeometry, tracker]);

  if (!colors || !selectedObject || !effectiveDraftAndBounds) return null;

  const { draft, bounds } = effectiveDraftAndBounds;
  const pose = resolveTextureGizmoWorldPose(draft, bounds);
  const L = pose.handleLength;
  const shaftRadius = Math.max(L * 0.032, 1e-12);
  const tipSize = Math.max(L * 0.11, 1e-12);
  const xColor = colors.danger ?? "#f38ba8";
  const yColor = colors.success ?? "#a6e3a1";
  const zColor = colors.accent;

  const startHandleDrag = (
    mode: Exclude<TextureGizmoMode, "view">,
    handle: TranslateHandleId | GizmoAxis | ScaleHandleId,
    event: ThreeEvent<PointerEvent>,
  ) => {
    event.stopPropagation();
    const targetEl = event.target as unknown as {
      setPointerCapture?: (id: number) => void;
      releasePointerCapture?: (id: number) => void;
    };
    try {
      targetEl.setPointerCapture?.(event.pointerId);
    } catch {
      // Ignore synthetic events without native pointer capture
    }
    const normal = resolveDragPlaneNormal(mode, handle, event.ray?.direction);
    const anchor = new Vector3(...pose.originWorld);
    const dragPlane = new Plane().setFromNormalAndCoplanarPoint(normal, anchor);
    const fallbackPt = extractEventPoint(event, pose.originWorld);
    const startPoint = intersectRayOrFallback(event.ray, dragPlane, fallbackPt);

    dragStore.set({
      pointerId: event.pointerId,
      mode,
      handle,
      dragPlane,
      startPoint,
      startTranslationM: [...draft.translationM],
      startQuat: [...draft.rotationQuat],
      startEulerDeg: [...draft.eulerDeg],
      startScale: [...draft.scale],
      uniformLocked: draft.uniformScaleLocked,
      originWorld: pose.originWorld,
      handleLength: L,
      releaseCapture: (id) => {
        try {
          targetEl.releasePointerCapture?.(id);
        } catch {
          // Ignore already released capture
        }
      },
    });
    beginTextureGizmoGesture();
    invalidate();
  };

  const moveHandleDrag = (event: ThreeEvent<PointerEvent>) => {
    const session = dragStore.get();
    if (!session || session.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const fallbackPt = extractEventPoint(event, session.startPoint);
    const currentPt = intersectRayOrFallback(event.ray, session.dragPlane, fallbackPt);
    const shiftKey = Boolean(event.nativeEvent?.shiftKey);

    if (session.mode === "translate") {
      const delta: Vec3 = [
        currentPt[0] - session.startPoint[0],
        currentPt[1] - session.startPoint[1],
        currentPt[2] - session.startPoint[2],
      ];
      const nextTranslation = applyTextureGizmoTranslateDrag(
        session.startTranslationM,
        delta,
        session.handle as TranslateHandleId,
        shiftKey,
      );
      patchActiveTextureDraft({ translationM: nextTranslation });
    } else if (session.mode === "rotate") {
      const axis = session.handle as GizmoAxis;
      const v0: Vec3 = [
        session.startPoint[0] - session.originWorld[0],
        session.startPoint[1] - session.originWorld[1],
        session.startPoint[2] - session.originWorld[2],
      ];
      const v1: Vec3 = [
        currentPt[0] - session.originWorld[0],
        currentPt[1] - session.originWorld[1],
        currentPt[2] - session.originWorld[2],
      ];
      let angle0 = 0;
      let angle1 = 0;
      if (axis === "x") {
        angle0 = Math.atan2(v0[2], v0[1]);
        angle1 = Math.atan2(v1[2], v1[1]);
      } else if (axis === "y") {
        angle0 = Math.atan2(v0[0], v0[2]);
        angle1 = Math.atan2(v1[0], v1[2]);
      } else {
        angle0 = Math.atan2(v0[1], v0[0]);
        angle1 = Math.atan2(v1[1], v1[0]);
      }
      const nextRot = applyTextureGizmoRotateDrag(
        session.startQuat,
        session.startEulerDeg,
        axis,
        angle1 - angle0,
        shiftKey,
      );
      patchActiveTextureDraft(nextRot);
    } else if (session.mode === "scale") {
      const handle = session.handle as ScaleHandleId;
      let ratio = 1;
      if (handle === "uniform") {
        const d0 = Math.max(
          Math.hypot(
            session.startPoint[0] - session.originWorld[0],
            session.startPoint[1] - session.originWorld[1],
            session.startPoint[2] - session.originWorld[2],
          ),
          session.handleLength * 0.25,
        );
        const d1 = Math.hypot(
          currentPt[0] - session.originWorld[0],
          currentPt[1] - session.originWorld[1],
          currentPt[2] - session.originWorld[2],
        );
        ratio = Math.max(MIN_SCALE_FACTOR, d1 / d0);
      } else {
        const idx = handle === "x" ? 0 : handle === "y" ? 1 : 2;
        const deltaAxis = currentPt[idx]! - session.startPoint[idx]!;
        ratio = Math.max(MIN_SCALE_FACTOR, 1 + deltaAxis / Math.max(session.handleLength, 1e-12));
      }
      const nextScale = applyTextureGizmoScaleDrag(
        session.startScale,
        handle,
        ratio,
        session.uniformLocked,
        shiftKey,
      );
      patchActiveTextureDraft({ scale: nextScale });
    }
    invalidate();
  };

  const finishHandleDrag = (event: ThreeEvent<PointerEvent>) => {
    const session = dragStore.get();
    if (!session || session.pointerId !== event.pointerId) return;
    event.stopPropagation();
    session.releaseCapture(session.pointerId);
    dragStore.clear();
    endTextureGizmoGesture();
    invalidate();
  };

  const pointerHandlersFor = (
    mode: Exclude<TextureGizmoMode, "view">,
    handle: TranslateHandleId | GizmoAxis | ScaleHandleId,
  ) => ({
    onPointerDown: (event: ThreeEvent<PointerEvent>) => startHandleDrag(mode, handle, event),
    onPointerMove: moveHandleDrag,
    onPointerUp: finishHandleDrag,
    onPointerCancel: finishHandleDrag,
    onLostPointerCapture: finishHandleDrag,
  });

  return (
    <group
      name={`texture-transform-layer:${selectedObject.objectId}`}
      userData={{ gizmo: "texture-transform-layer", objectId: selectedObject.objectId }}
    >
      {surfaceGeometry ? (
        <mesh
          geometry={surfaceGeometry}
          renderOrder={RENDER_POLICIES.selectionShell.renderOrder - 1}
          userData={{
            gizmo: "texture-surface-preview",
            objectId: selectedObject.objectId,
          }}
        >
          <meshBasicMaterial
            opacity={0.92}
            polygonOffset
            polygonOffsetFactor={-1}
            polygonOffsetUnits={-1}
            toneMapped={false}
            transparent
            vertexColors
          />
        </mesh>
      ) : null}

      {bridge.gizmoEnabled ? (
        <group
          name={`texture-gizmo:${selectedObject.objectId}`}
          position={pose.originWorld}
          userData={{
            gizmo: "texture-transform",
            mode: bridge.gizmoMode,
            objectId: selectedObject.objectId,
          }}
        >
          {proxyGeometry ? (
            <lineSegments
              geometry={proxyGeometry}
              renderOrder={RENDER_POLICIES.selectionShell.renderOrder}
              userData={{ gizmo: "texture-characteristic-proxy" }}
            >
              <lineBasicMaterial
                color={colors.accent}
                depthTest={false}
                opacity={0.85}
                toneMapped={false}
                transparent
              />
            </lineSegments>
          ) : null}

          {/* Center anchor sphere — double-click centers texture in target bounds */}
          <mesh
            onDoubleClick={(event) => {
              event.stopPropagation();
              patchActiveTextureDraft({ translationM: [0, 0, 0] });
              invalidate();
            }}
            renderOrder={RENDER_POLICIES.selectionShell.renderOrder + 1}
            userData={{ gizmo: "texture-center-anchor" }}
          >
            <sphereGeometry args={[tipSize * 0.55, 16, 12]} />
            <meshBasicMaterial color={colors.textPrimary} depthTest={false} toneMapped={false} />
          </mesh>

          {bridge.gizmoMode === "translate" ? (
            <group userData={{ gizmoMode: "translate" }}>
              {(
                [
                  { axis: "x" as const, pos: [L * 0.5, 0, 0] as Vec3, rot: [0, 0, -Math.PI / 2] as Vec3, color: xColor },
                  { axis: "y" as const, pos: [0, L * 0.5, 0] as Vec3, rot: [0, 0, 0] as Vec3, color: yColor },
                  { axis: "z" as const, pos: [0, 0, L * 0.5] as Vec3, rot: [Math.PI / 2, 0, 0] as Vec3, color: zColor },
                ] as const
              ).map(({ axis, pos, rot, color }) => (
                <mesh
                  key={axis}
                  {...pointerHandlersFor("translate", axis)}
                  position={pos}
                  renderOrder={RENDER_POLICIES.selectionShell.renderOrder + 1}
                  rotation={rot}
                  userData={{ axis, gizmo: "texture-translate-axis" }}
                >
                  <cylinderGeometry args={[shaftRadius, shaftRadius, L, 12]} />
                  <meshBasicMaterial color={color} depthTest={false} toneMapped={false} />
                </mesh>
              ))}
              {(
                [
                  { plane: "xy" as const, pos: [L * 0.22, L * 0.22, 0] as Vec3, rot: [0, 0, 0] as Vec3, color: zColor },
                  { plane: "xz" as const, pos: [L * 0.22, 0, L * 0.22] as Vec3, rot: [Math.PI / 2, 0, 0] as Vec3, color: yColor },
                  { plane: "yz" as const, pos: [0, L * 0.22, L * 0.22] as Vec3, rot: [0, Math.PI / 2, 0] as Vec3, color: xColor },
                ] as const
              ).map(({ plane, pos, rot, color }) => (
                <mesh
                  key={plane}
                  {...pointerHandlersFor("translate", plane)}
                  position={pos}
                  renderOrder={RENDER_POLICIES.selectionShell.renderOrder + 1}
                  rotation={rot}
                  userData={{ gizmo: "texture-translate-plane", plane }}
                >
                  <planeGeometry args={[L * 0.18, L * 0.18]} />
                  <meshBasicMaterial
                    color={color}
                    depthTest={false}
                    opacity={0.45}
                    toneMapped={false}
                    transparent
                  />
                </mesh>
              ))}
            </group>
          ) : null}

          {bridge.gizmoMode === "rotate" ? (
            <group userData={{ gizmoMode: "rotate" }}>
              {(
                [
                  { axis: "x" as const, rot: [0, Math.PI / 2, 0] as Vec3, color: xColor },
                  { axis: "y" as const, rot: [Math.PI / 2, 0, 0] as Vec3, color: yColor },
                  { axis: "z" as const, rot: [0, 0, 0] as Vec3, color: zColor },
                ] as const
              ).map(({ axis, rot, color }) => (
                <mesh
                  key={axis}
                  {...pointerHandlersFor("rotate", axis)}
                  renderOrder={RENDER_POLICIES.selectionShell.renderOrder + 1}
                  rotation={rot}
                  userData={{ axis, gizmo: "texture-rotate-ring" }}
                >
                  <torusGeometry args={[L * 0.8, shaftRadius * 0.9, 12, 48]} />
                  <meshBasicMaterial color={color} depthTest={false} toneMapped={false} />
                </mesh>
              ))}
            </group>
          ) : null}

          {bridge.gizmoMode === "scale" ? (
            <group userData={{ gizmoMode: "scale" }}>
              <mesh
                {...pointerHandlersFor("scale", "uniform")}
                renderOrder={RENDER_POLICIES.selectionShell.renderOrder + 2}
                userData={{ gizmo: "texture-scale-uniform" }}
              >
                <boxGeometry args={[tipSize * 1.25, tipSize * 1.25, tipSize * 1.25]} />
                <meshBasicMaterial color={colors.accent} depthTest={false} toneMapped={false} />
              </mesh>
              {(
                [
                  { axis: "x" as const, pos: [L, 0, 0] as Vec3, color: xColor },
                  { axis: "y" as const, pos: [0, L, 0] as Vec3, color: yColor },
                  { axis: "z" as const, pos: [0, 0, L] as Vec3, color: zColor },
                ] as const
              ).map(({ axis, pos, color }) => (
                <mesh
                  key={axis}
                  {...pointerHandlersFor("scale", axis)}
                  position={pos}
                  renderOrder={RENDER_POLICIES.selectionShell.renderOrder + 1}
                  userData={{ axis, gizmo: "texture-scale-axis" }}
                >
                  <boxGeometry args={[tipSize, tipSize, tipSize]} />
                  <meshBasicMaterial color={color} depthTest={false} toneMapped={false} />
                </mesh>
              ))}
            </group>
          ) : null}
        </group>
      ) : null}
    </group>
  );
}
