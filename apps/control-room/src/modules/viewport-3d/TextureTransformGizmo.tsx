"use client";

import { useThree, type ThreeEvent } from "@react-three/fiber";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Plane,
  Quaternion,
  Raycaster,
  Vector2,
  Vector3,
  type Camera,
  type ColorRepresentation,
  type Group,
  type Object3D,
  type Ray,
} from "three";

import type { SceneResource } from "@/kernel/api/apiTypes";
import { resolveCanonicalQuantityId } from "@/kernel/api/quantityIds";
import { computeSceneGeometryBoundsMeters } from "@/shared/domain/geometry/sceneGeometryBounds";
import {
  compileSceneGeometryContainment,
  type SceneGeometryContainmentTester,
} from "@/shared/domain/geometry/sceneGeometryContainment";
import type { TargetMetricBounds, Vec3 } from "@/shared/domain/magnetization-texture/boundsResolver";
import {
  pointInsideRegionShape,
  resolveTargetBoundsMeters,
} from "@/shared/domain/magnetization-texture/boundsResolver";
import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";
import {
  axisAngleToQuaternion,
  multiplyQuaternions,
  normalizeQuaternion,
  quaternionToEulerDegrees,
  rotateVectorByQuaternion,
  samplePresetTextureV2Client,
  type PresetTextureSpecV2,
  type Quat4,
} from "@/shared/domain/magnetization-texture/evaluateV2Client";
import {
  buildPresetSpecFromDraft,
  hydrateMagneticTextureDraftFromInitializer,
  type MagneticTextureDraft,
} from "@/shared/domain/magnetization-texture/presetDefaults";
import {
  beginTextureGizmoGesture,
  endTextureGizmoGesture,
  getTextureDraftBridgeSnapshot,
  handleTextureGizmoShortcutKey,
  isTextureGizmoHandleModeActive,
  patchActiveTextureDraft,
  subscribeTextureDraftBridge,
  type TextureGizmoMode,
  type TextureInspectorDraftBinding,
} from "@/shared/domain/magnetization-texture/textureDraftBridge";
import { canonicalPresetKind } from "@/shared/domain/magnetization-texture/texturePresets";
import { scalarColorRgb } from "@/shared/visualization/scalarColorPalette";

import { useViewport3DColors } from "./hooks/useViewport3DColors";
import {
  buildArray3DInstanceMatrices,
  extractArray3DPreviewDescriptors,
} from "./layers/Array3DInstancedPreviewLayer";
import type { Viewport3DPickModifiers } from "./layers/PrimitiveObjectLayer";
import { eventIntersectsRegionOverlay } from "./layers/regionOverlayPicking";
import {
  buildTopologySurfacePreviewData,
  composePrimitiveObjectWorldMatrix,
  sampleCompositeSurfaceVectorAnchors,
  type SubdividedSurfacePreviewData,
} from "./layers/textureSurfacePreviewGeometry";
import {
  ensureWhiteVertexColorAttribute,
  resolveVectorGlyphDepthPolicy,
} from "./layers/VectorFieldLayer.model";
import {
  buildVectorGlyphTransforms,
  type VectorGlyphTransforms,
} from "./layers/vectorGlyphGeometry";
import { RENDER_POLICIES } from "./layers/viewport3DRenderPolicy";
import { magnetizationHslLinearRgb } from "./orientation/magnetizationColor";
import { useBatchedInvalidate } from "./viewport3dBatchedInvalidate";
import type { Viewport3DResourceTracker } from "./viewport3dDiagnostics";
import {
  sampleViewport3DSurfaceHslColors,
  type SampleViewport3DSurfaceHslOptions,
  type Viewport3DPrimitiveObject,
  type Viewport3DPrimitiveRenderModel,
} from "./viewport3dPrimitiveModel";
import type { Viewport3DColors } from "./viewport3dTypes";
import { normalizeViewport3DVectorColorMode } from "./viewport3dVectorColoring";

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

function isInsideViewport3DContainer(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as {
    tagName?: string;
    classList?: { contains?: (cls: string) => boolean };
    closest?: (selector: string) => unknown;
  };
  if ((el.tagName ?? "").toUpperCase() === "CANVAS") return true;
  if (
    el.classList?.contains?.("fm-viewport-3d") ||
    el.classList?.contains?.("fm-viewport-3d__canvas")
  ) {
    return true;
  }
  if (typeof el.closest === "function") {
    return Boolean(
      el.closest(".fm-viewport-3d, .fm-viewport-3d__canvas, [data-viewport-3d-canvas]"),
    );
  }
  return false;
}

export function installTextureGizmoKeyboardShortcuts(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  options?: {
    isViewportFocused?: (eventTarget: EventTarget | null) => boolean;
  },
): () => void {
  const onKeyDown = (rawEvent: Event) => {
    const event = rawEvent as KeyboardEvent;
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (isEditableKeyboardTarget(event.target)) return;
    const bridge = getTextureDraftBridgeSnapshot();
    const sessionActive = bridge.gizmoEnabled || bridge.activeBinding !== null;
    const activeElement =
      typeof document !== "undefined" ? document.activeElement : null;
    const viewportFocused =
      options?.isViewportFocused?.(event.target) ??
      (isInsideViewport3DContainer(event.target) ||
        isInsideViewport3DContainer(activeElement));
    if (!sessionActive && !viewportFocused) return;
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
 * Generates a subdivided surface preview mesh in world coordinates honoring the
 * exact CSG / composite / primitive / Array3D topology of `object` so analytical
 * spin textures (skyrmions, vortices, domain walls, helices) stay crisp around
 * cut-out holes and across all arrayed instances without covering holes.
 */
export function buildSubdividedSurfacePreviewData(
  object: Viewport3DPrimitiveObject,
  gridRes = SURFACE_PREVIEW_GRID_RES,
): SubdividedSurfacePreviewData {
  return buildTopologySurfacePreviewData(object, gridRes);
}

export type GizmoHandleMode = Exclude<TextureGizmoMode, "view">;
export type AnyGizmoHandleId = TranslateHandleId | GizmoAxis | ScaleHandleId;

export interface GizmoHandleDescriptor {
  readonly mode: GizmoHandleMode;
  readonly handle: AnyGizmoHandleId;
  readonly key: string;
  readonly priority?: number;
}

export type PickedTextureGizmoTarget =
  | {
      readonly kind: "handle";
      readonly mode: GizmoHandleMode;
      readonly handle: AnyGizmoHandleId;
      readonly key: string;
      readonly point: Vec3;
    }
  | {
      readonly kind: "center-anchor";
      readonly point: Vec3;
    };

export interface GizmoDomCanvasLike {
  getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
  setPointerCapture?: (pointerId: number) => void;
  releasePointerCapture?: (pointerId: number) => void;
  addEventListener?: HTMLElement["addEventListener"];
  removeEventListener?: HTMLElement["removeEventListener"];
  style?: { cursor: string };
}

export interface GizmoWindowTargetLike {
  addEventListener: Window["addEventListener"];
  removeEventListener: Window["removeEventListener"];
}

export interface TextureGizmoLiveDragContext {
  readonly camera: Camera;
  readonly canvas: GizmoDomCanvasLike | null;
  readonly controls: { enabled?: boolean } | null;
  readonly draft: MagneticTextureDraft;
  readonly pose: TextureGizmoWorldPose;
  readonly windowTarget: GizmoWindowTargetLike | null;
  readonly onGestureActiveChange?: (active: boolean) => void;
  readonly onActiveKeyChange?: (key: string | null) => void;
  readonly invalidate: () => void;
}

interface ActiveDragSession {
  pointerId: number;
  mode: GizmoHandleMode;
  handle: AnyGizmoHandleId;
  key: string;
  dragPlane: Plane;
  uniformDiagAxis: Vec3;
  startPoint: Vec3;
  startTranslationM: Vec3;
  startQuat: Quat4;
  startEulerDeg: Vec3;
  startScale: Vec3;
  uniformLocked: boolean;
  originWorld: Vec3;
  handleLength: number;
  prevControlsEnabled: boolean;
  cleanupWindowListeners: () => void;
}

export function resolveDragPlaneNormal(
  mode: GizmoHandleMode,
  handle: AnyGizmoHandleId,
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

  const viewDir =
    rayDirection && rayDirection.lengthSq() > 1e-12
      ? rayDirection.clone().normalize()
      : new Vector3(0, 0, -1);

  if (handle === "x" || handle === "y" || handle === "z") {
    const axisVec =
      handle === "x"
        ? new Vector3(1, 0, 0)
        : handle === "y"
          ? new Vector3(0, 1, 0)
          : new Vector3(0, 0, 1);
    const perp = new Vector3().crossVectors(axisVec, viewDir);
    if (perp.lengthSq() > 1e-6) {
      return new Vector3().crossVectors(perp, axisVec).normalize();
    }
    return handle === "z" ? new Vector3(1, 0, 0) : new Vector3(0, 0, 1);
  }

  return viewDir;
}

function resolveCameraDiagonalAxis(camera: Camera): Vec3 {
  camera.updateMatrixWorld();
  const e = camera.matrixWorld.elements;
  const rx = e[0] ?? 1;
  const ry = e[1] ?? 0;
  const rz = e[2] ?? 0;
  const ux = e[4] ?? 0;
  const uy = e[5] ?? 1;
  const uz = e[6] ?? 0;
  const dx = rx + ux;
  const dy = ry + uy;
  const dz = rz + uz;
  const len = Math.hypot(dx, dy, dz);
  if (len > 1e-9) {
    return [dx / len, dy / len, dz / len];
  }
  return [Math.SQRT1_2, Math.SQRT1_2, 0];
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

function readHandleFromObject(object: Object3D | null):
  | { kind: "handle"; descriptor: GizmoHandleDescriptor }
  | { kind: "center-anchor" }
  | null {
  let current: Object3D | null = object;
  while (current) {
    const ud = current.userData as
      | {
          gizmo?: string;
          gizmoHandle?: GizmoHandleDescriptor;
        }
      | undefined;
    if (ud?.gizmoHandle) {
      return { kind: "handle", descriptor: ud.gizmoHandle };
    }
    if (ud?.gizmo === "texture-center-anchor") {
      return { kind: "center-anchor" };
    }
    current = current.parent;
  }
  return null;
}

export function pickTextureGizmoHandleFromGroup(
  group: Object3D,
  raycaster: Raycaster,
): PickedTextureGizmoTarget | null {
  group.updateWorldMatrix(true, true);
  const hits = raycaster.intersectObject(group, true);
  if (hits.length === 0) return null;

  let bestHandle: {
    descriptor: GizmoHandleDescriptor;
    point: Vec3;
    priority: number;
  } | null = null;
  let centerAnchorHit: Vec3 | null = null;

  for (const hit of hits) {
    const resolved = readHandleFromObject(hit.object);
    if (!resolved) continue;
    const pt: Vec3 = [hit.point.x, hit.point.y, hit.point.z];
    if (resolved.kind === "center-anchor") {
      if (!centerAnchorHit) centerAnchorHit = pt;
      continue;
    }
    const priority = resolved.descriptor.priority ?? 1;
    if (!bestHandle || priority > bestHandle.priority) {
      bestHandle = { descriptor: resolved.descriptor, point: pt, priority };
    }
  }

  if (bestHandle) {
    return {
      kind: "handle",
      mode: bestHandle.descriptor.mode,
      handle: bestHandle.descriptor.handle,
      key: bestHandle.descriptor.key,
      point: bestHandle.point,
    };
  }
  if (centerAnchorHit) {
    return { kind: "center-anchor", point: centerAnchorHit };
  }
  return null;
}

export function createTextureGizmoDragController(
  initialGetter?: () => TextureGizmoLiveDragContext,
) {
  let latestContext: TextureGizmoLiveDragContext | null = null;
  const getContext = (): TextureGizmoLiveDragContext => {
    if (initialGetter) return initialGetter();
    if (!latestContext) {
      throw new Error("TextureGizmoDragController context has not been synchronized.");
    }
    return latestContext;
  };
  let activeSession: ActiveDragSession | null = null;
  const ndc = new Vector2();
  const raycaster = new Raycaster();

  const applyRayUpdate = (session: ActiveDragSession, ray: Ray, shiftKey: boolean) => {
    const currentPt = intersectRayOrFallback(ray, session.dragPlane, session.startPoint);

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
        const dx = currentPt[0] - session.startPoint[0];
        const dy = currentPt[1] - session.startPoint[1];
        const dz = currentPt[2] - session.startPoint[2];
        const diagDelta =
          dx * session.uniformDiagAxis[0] +
          dy * session.uniformDiagAxis[1] +
          dz * session.uniformDiagAxis[2];
        ratio = Math.max(
          MIN_SCALE_FACTOR,
          Math.min(
            MAX_SCALE_FACTOR,
            Math.exp(diagDelta / Math.max(session.handleLength * 0.6, 1e-12)),
          ),
        );
      } else {
        const idx = handle === "x" ? 0 : handle === "y" ? 1 : 2;
        const deltaAxis = currentPt[idx]! - session.startPoint[idx]!;
        ratio = Math.max(
          MIN_SCALE_FACTOR,
          1 + deltaAxis / Math.max(session.handleLength, 1e-12),
        );
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
    getContext().invalidate();
  };

  const finishDrag = (revertToStart: boolean): boolean => {
    const session = activeSession;
    if (!session) return false;
    activeSession = null;
    session.cleanupWindowListeners();

    const ctx = getContext();
    try {
      ctx.canvas?.releasePointerCapture?.(session.pointerId);
    } catch {
      // Ignore already released pointer capture
    }
    if (ctx.canvas?.style) {
      ctx.canvas.style.cursor = "";
    }
    if (ctx.controls && "enabled" in ctx.controls) {
      ctx.controls.enabled = session.prevControlsEnabled;
    }
    if (revertToStart) {
      patchActiveTextureDraft({
        translationM: [...session.startTranslationM],
        rotationQuat: [...session.startQuat],
        eulerDeg: [...session.startEulerDeg],
        scale: [...session.startScale],
      });
    }
    ctx.onActiveKeyChange?.(null);
    ctx.onGestureActiveChange?.(false);
    endTextureGizmoGesture();
    ctx.invalidate();
    return true;
  };

  const beginDrag = ({
    pointerId,
    mode,
    handle,
    key,
    ray,
    hitPoint,
  }: {
    pointerId: number;
    mode: GizmoHandleMode;
    handle: AnyGizmoHandleId;
    key: string;
    ray?: Ray;
    hitPoint: Vec3;
  }): boolean => {
    if (activeSession) return false;
    const ctx = getContext();
    const prevControlsEnabled = ctx.controls ? ctx.controls.enabled !== false : true;
    if (ctx.controls && "enabled" in ctx.controls) {
      ctx.controls.enabled = false;
    }
    ctx.onGestureActiveChange?.(true);
    beginTextureGizmoGesture();
    ctx.onActiveKeyChange?.(key);

    try {
      ctx.canvas?.setPointerCapture?.(pointerId);
    } catch {
      // Synthetic test events may not have native pointerId registration
    }
    if (ctx.canvas?.style) {
      ctx.canvas.style.cursor = "grabbing";
    }

    const normal = resolveDragPlaneNormal(mode, handle, ray?.direction);
    const anchor = new Vector3(...ctx.pose.originWorld);
    const dragPlane = new Plane().setFromNormalAndCoplanarPoint(normal, anchor);
    const startPoint = intersectRayOrFallback(ray, dragPlane, hitPoint);
    const uniformDiagAxis = resolveCameraDiagonalAxis(ctx.camera);

    const onWindowPointerMove = (rawEvent: Event) => {
      const event = rawEvent as PointerEvent;
      if (!activeSession || event.pointerId !== activeSession.pointerId) return;
      const liveCtx = getContext();
      const rect = liveCtx.canvas?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      ndc.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      liveCtx.camera.updateMatrixWorld();
      raycaster.setFromCamera(ndc, liveCtx.camera);
      applyRayUpdate(activeSession, raycaster.ray, Boolean(event.shiftKey));
    };

    const onWindowPointerUp = (rawEvent: Event) => {
      const event = rawEvent as PointerEvent;
      if (!activeSession || event.pointerId !== activeSession.pointerId) return;
      finishDrag(false);
    };

    const onWindowPointerCancel = (rawEvent: Event) => {
      const event = rawEvent as PointerEvent;
      if (!activeSession || event.pointerId !== activeSession.pointerId) return;
      finishDrag(false);
    };

    const onWindowKeyDown = (rawEvent: Event) => {
      const event = rawEvent as KeyboardEvent;
      if (!activeSession || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation?.();
      finishDrag(true);
    };

    const win = ctx.windowTarget;
    if (win) {
      win.addEventListener("pointermove", onWindowPointerMove);
      win.addEventListener("pointerup", onWindowPointerUp);
      win.addEventListener("pointercancel", onWindowPointerCancel);
      win.addEventListener("keydown", onWindowKeyDown);
    }

    activeSession = {
      pointerId,
      mode,
      handle,
      key,
      dragPlane,
      uniformDiagAxis,
      startPoint,
      startTranslationM: [...ctx.draft.translationM],
      startQuat: [...ctx.draft.rotationQuat],
      startEulerDeg: [...ctx.draft.eulerDeg],
      startScale: [...ctx.draft.scale],
      uniformLocked: ctx.draft.uniformScaleLocked,
      originWorld: [...ctx.pose.originWorld],
      handleLength: ctx.pose.handleLength,
      prevControlsEnabled,
      cleanupWindowListeners: () => {
        if (!win) return;
        win.removeEventListener("pointermove", onWindowPointerMove);
        win.removeEventListener("pointerup", onWindowPointerUp);
        win.removeEventListener("pointercancel", onWindowPointerCancel);
        win.removeEventListener("keydown", onWindowKeyDown);
      },
    };

    ctx.invalidate();
    return true;
  };

  return {
    syncContext(next: TextureGizmoLiveDragContext): void {
      latestContext = next;
    },
    isActive(): boolean {
      return activeSession !== null;
    },
    beginDrag,
    moveWithRay(pointerId: number, ray: Ray, shiftKey = false): void {
      if (!activeSession || activeSession.pointerId !== pointerId) return;
      applyRayUpdate(activeSession, ray, shiftKey);
    },
    endPointer(pointerId: number): boolean {
      if (!activeSession || activeSession.pointerId !== pointerId) return false;
      return finishDrag(false);
    },
    cancelEscape(): boolean {
      return finishDrag(true);
    },
    dispose(): void {
      finishDrag(false);
    },
  };
}

const AUTHORED_VECTOR_BUDGET_MIN = 16;
const AUTHORED_VECTOR_BUDGET_MAX = 2000;
const AUTHORED_VECTOR_DEFAULT_BUDGET = 196;
const AUTHORED_ARROW_LENGTH_FACTOR = 0.85;
const AUTHORED_ARROW_HEAD_LENGTH_RATIO = 0.34;
const AUTHORED_ARROW_HEAD_RADIUS_RATIO = 0.145;
const AUTHORED_ARROW_SHAFT_RADIUS_RATIO = 0.052;
const AUTHORED_VECTOR_THICKNESS_MIN = 0.25;
const AUTHORED_VECTOR_THICKNESS_MAX = 4;
const AUTHORED_VECTOR_UNIT_Y = new Vector3(0, 1, 0);

interface CompiledAuthoredRegionLayer {
  readonly regionId: string;
  readonly priority: number;
  readonly regionRecord: Record<string, unknown>;
  readonly spec: PresetTextureSpecV2;
  readonly regionBounds: TargetMetricBounds;
}

function asAuthoredRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asAuthoredString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asAuthoredNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isAuthoredFieldFileAsset(asset: Record<string, unknown>): boolean {
  const kind = asAuthoredString(asset.kind) ?? "";
  if (
    kind === "sampled" ||
    kind === "field_file" ||
    kind === "field-file" ||
    kind === "imported_field"
  ) {
    return true;
  }
  return asset.source_mode === "field-file";
}

export interface SampleAuthoredMagnetizationVectorsOptions {
  readonly scene: SceneResource | null;
  readonly objectId: string;
  readonly positionsWorld: Float32Array;
  readonly liveBinding?: TextureInspectorDraftBinding | null;
}

/**
 * Evaluates unit magnetization vectors (mx, my, mz) at arbitrary world points
 * using the canonical v2 preset texture evaluator and enabled region overrides
 * (exact parity with `sampleViewport3DSurfaceHslColors`).
 */
export function sampleAuthoredMagnetizationVectors({
  scene,
  objectId,
  positionsWorld,
  liveBinding = null,
}: SampleAuthoredMagnetizationVectorsOptions): Float32Array | null {
  const pointCount = Math.floor(positionsWorld.length / 3);
  if (pointCount <= 0) return null;

  const sceneRec = asAuthoredRecord(scene);
  const objectRec = Array.isArray(sceneRec?.objects)
    ? sceneRec.objects
        .map(asAuthoredRecord)
        .find((entry) => entry && asAuthoredString(entry.id) === objectId) ?? null
    : null;

  const objectTarget = { kind: "object" as const, objectId };
  const objectBounds =
    liveBinding?.target.kind === "object" && liveBinding.target.objectId === objectId
      ? liveBinding.bounds
      : resolveTargetBoundsMeters(scene, objectTarget);
  const objectTransform = asAuthoredRecord(objectRec?.transform);

  try {
    let objectSpec: PresetTextureSpecV2 | null = null;
    if (liveBinding?.target.kind === "object" && liveBinding.target.objectId === objectId) {
      if (liveBinding.draft.sourceMode !== "field-file") {
        objectSpec = buildPresetSpecFromDraft(liveBinding.draft, objectBounds);
      }
    } else if (sceneRec && objectRec) {
      const refId = asAuthoredString(objectRec.magnetization_ref);
      const asset =
        refId && Array.isArray(sceneRec.magnetization_assets)
          ? sceneRec.magnetization_assets
              .map(asAuthoredRecord)
              .find((entry) => entry && asAuthoredString(entry.id) === refId) ?? null
          : null;
      if (asset && !isAuthoredFieldFileAsset(asset)) {
        const draft = hydrateMagneticTextureDraftFromInitializer(asset, objectBounds, "object");
        objectSpec = buildPresetSpecFromDraft(draft, objectBounds);
      }
    }

    const regionLayers: CompiledAuthoredRegionLayer[] = [];
    const rawRegions = Array.isArray(objectRec?.regions) ? objectRec.regions : [];
    for (const rawRegion of rawRegions) {
      const reg = asAuthoredRecord(rawRegion);
      if (!reg || reg.enabled === false) continue;
      const regionId = asAuthoredString(reg.region_id);
      if (!regionId) continue;
      const priority = asAuthoredNumber(reg.priority) ?? 0;
      const regBounds =
        liveBinding?.target.kind === "region" &&
        liveBinding.target.objectId === objectId &&
        liveBinding.target.regionId === regionId
          ? liveBinding.bounds
          : resolveTargetBoundsMeters(scene, { kind: "region", objectId, regionId });

      if (
        liveBinding?.target.kind === "region" &&
        liveBinding.target.objectId === objectId &&
        liveBinding.target.regionId === regionId
      ) {
        if (
          liveBinding.draft.inheritanceMode === "override" &&
          liveBinding.draft.sourceMode !== "field-file"
        ) {
          regionLayers.push({
            regionId,
            priority,
            regionRecord: reg,
            spec: buildPresetSpecFromDraft(liveBinding.draft, regBounds),
            regionBounds: regBounds,
          });
        }
        continue;
      }

      const init = asAuthoredRecord(asAuthoredRecord(reg.texture_override)?.initial_magnetization);
      if (init && !isAuthoredFieldFileAsset(init)) {
        const regDraft = hydrateMagneticTextureDraftFromInitializer(init, regBounds, "region", {
          inherited: false,
        });
        regionLayers.push({
          regionId,
          priority,
          regionRecord: reg,
          spec: buildPresetSpecFromDraft(regDraft, regBounds),
          regionBounds: regBounds,
        });
      }
    }

    regionLayers.sort((left, right) => right.priority - left.priority);

    if (!objectSpec && regionLayers.length === 0) {
      return null;
    }

    const outVectors = new Float32Array(pointCount * 3);
    for (let i = 0; i < pointCount; i += 1) {
      const base = i * 3;
      const worldPt: Vec3 = [
        positionsWorld[base]!,
        positionsWorld[base + 1]!,
        positionsWorld[base + 2]!,
      ];
      const positionObject: Vec3 = [
        worldPt[0] - objectBounds.worldCenter[0],
        worldPt[1] - objectBounds.worldCenter[1],
        worldPt[2] - objectBounds.worldCenter[2],
      ];

      let chosenSpec: PresetTextureSpecV2 | null = objectSpec;
      let chosenBounds: TargetMetricBounds = objectBounds;
      for (const layer of regionLayers) {
        if (pointInsideRegionShape(positionObject, layer.regionRecord, objectTransform)) {
          chosenSpec = layer.spec;
          chosenBounds = layer.regionBounds;
          break;
        }
      }

      const positionRegion: Vec3 = [
        worldPt[0] - chosenBounds.worldCenter[0],
        worldPt[1] - chosenBounds.worldCenter[1],
        worldPt[2] - chosenBounds.worldCenter[2],
      ];

      const spin = chosenSpec
        ? samplePresetTextureV2Client(
            chosenSpec,
            {
              positionObject,
              positionRegion,
              positionWorld: worldPt,
            },
            chosenBounds,
          )
        : ([1, 0, 0] as const);

      outVectors[base] = spin[0];
      outVectors[base + 1] = spin[1];
      outVectors[base + 2] = spin[2];
    }

    return outVectors;
  } catch {
    return null;
  }
}

export interface AuthoredMagnetizationVectorGridOptions {
  readonly budget?: number;
  readonly geometryScope?: "surface" | "full";
  readonly surfaceOffsetEnabled?: boolean;
  readonly surfaceOffsetScale?: number;
}

export interface AuthoredMagnetizationVectorGrid {
  readonly positionsWorld: Float32Array;
  readonly pitch: number;
  readonly count: number;
  readonly renderOnTop: boolean;
}

function resolveGrid2DCounts(
  spanA: number,
  spanB: number,
  targetCount: number,
): { na: number; nb: number; pitch: number } {
  const safeA = Math.max(spanA, 1e-12);
  const safeB = Math.max(spanB, 1e-12);
  const safeTarget = Math.max(1, Math.floor(targetCount));
  const idealPitch = Math.sqrt((safeA * safeB) / safeTarget);
  let na = Math.max(1, Math.round(safeA / idealPitch));
  let nb = Math.max(1, Math.round(safeB / idealPitch));
  while (na * nb > safeTarget && (na > 1 || nb > 1)) {
    if (na / safeA >= nb / safeB && na > 1) {
      na -= 1;
    } else if (nb > 1) {
      nb -= 1;
    } else {
      na -= 1;
    }
  }
  const pitch = Math.max(1e-12, Math.min(safeA / na, safeB / nb));
  return { na, nb, pitch };
}

interface ObjectLocalContainment {
  readonly localBounds: { center: Vec3; size: Vec3 };
  readonly tester: SceneGeometryContainmentTester;
  readonly worldMatrix: Matrix4;
}

function resolveObjectLocalContainment(
  object: Viewport3DPrimitiveObject,
): ObjectLocalContainment | null {
  const worldMatrix = composePrimitiveObjectWorldMatrix(object);
  if (object.rawGeometry) {
    const tester = compileSceneGeometryContainment(object.rawGeometry);
    const computed = computeSceneGeometryBoundsMeters(object.rawGeometry);
    const localSize = computed?.size ?? object.localSize ?? object.bounds.size;
    const localCenter = computed?.center ?? ([0, 0, 0] as Vec3);
    return {
      localBounds: {
        center: [localCenter[0], localCenter[1], localCenter[2]],
        size: [
          Math.max(localSize[0], 1e-12),
          Math.max(localSize[1], 1e-12),
          Math.max(localSize[2], 1e-12),
        ],
      },
      tester,
      worldMatrix,
    };
  }
  if (object.csgPreview?.kind === "box-cylinder-difference") {
    const p = object.csgPreview;
    const synth: Record<string, unknown> = {
      geometry_kind: "Difference",
      geometry_params: {
        operands: [
          {
            enabled: true,
            geometry: { geometry_kind: "Box", geometry_params: { size: p.boxSize } },
          },
          {
            enabled: true,
            geometry: {
              geometry_kind: "Cylinder",
              geometry_params: {
                axis: p.cylinderAxis,
                center: p.cylinderCenter,
                height: p.cylinderHeight,
                radius: p.cylinderRadius,
              },
            },
          },
        ],
      },
    };
    return {
      localBounds: {
        center: [0, 0, 0],
        size: [
          Math.max(p.boxSize[0], 1e-12),
          Math.max(p.boxSize[1], 1e-12),
          Math.max(p.boxSize[2], 1e-12),
        ],
      },
      tester: compileSceneGeometryContainment(synth),
      worldMatrix,
    };
  }
  if (object.csgPreview?.kind === "cylinder-cylinder-difference") {
    const p = object.csgPreview;
    const innerRel: Vec3 = [
      p.innerCenter[0] - p.outerCenter[0],
      p.innerCenter[1] - p.outerCenter[1],
      p.innerCenter[2] - p.outerCenter[2],
    ];
    const synth: Record<string, unknown> = {
      geometry_kind: "Difference",
      geometry_params: {
        operands: [
          {
            enabled: true,
            geometry: {
              geometry_kind: "Cylinder",
              geometry_params: {
                axis: p.cylinderAxis,
                height: p.outerHeight,
                radius: p.outerRadius,
              },
            },
          },
          {
            enabled: true,
            geometry: {
              geometry_kind: "Cylinder",
              geometry_params: {
                axis: p.cylinderAxis,
                center: innerRel,
                height: p.innerHeight,
                radius: p.innerRadius,
              },
            },
          },
        ],
      },
    };
    return {
      localBounds: {
        center: [0, 0, 0],
        size: [
          Math.max(p.boundsSize[0], 1e-12),
          Math.max(p.boundsSize[1], 1e-12),
          Math.max(p.boundsSize[2], 1e-12),
        ],
      },
      tester: compileSceneGeometryContainment(synth),
      worldMatrix,
    };
  }
  return null;
}

function buildArray3DVectorGridPoints(
  object: Viewport3DPrimitiveObject,
  targetCount: number,
  geometryScope: "surface" | "full",
  surfaceOffsetEnabled: boolean,
  surfaceOffsetScale: number,
): AuthoredMagnetizationVectorGrid | null {
  if (!object.rawGeometry) return null;
  const descriptor = extractArray3DPreviewDescriptors([object])[0];
  if (!descriptor) return null;
  const matrices = buildArray3DInstanceMatrices(descriptor);
  if (matrices.length === 0) return null;

  const childTester = compileSceneGeometryContainment(descriptor.childGeometry);
  const childBounds = computeSceneGeometryBoundsMeters(descriptor.childGeometry);
  const cCenter: Vec3 = childBounds ? [...childBounds.center] : [0, 0, 0];
  const cSize: Vec3 = childBounds
    ? [
        Math.max(childBounds.size[0], 1e-12),
        Math.max(childBounds.size[1], 1e-12),
        Math.max(childBounds.size[2], 1e-12),
      ]
    : [
        Math.max(descriptor.childSize[0], 1e-12),
        Math.max(descriptor.childSize[1], 1e-12),
        Math.max(descriptor.childSize[2], 1e-12),
      ];
  const [csx, csy, csz] = cSize;
  const chx = csx * 0.5;
  const chy = csy * 0.5;
  const chz = csz * 0.5;
  const cMaxSpan = Math.max(csx, csy, csz);
  const inset = Math.min(csx, csy, csz) * 1e-4;
  const childSurfaceLift = (pitch: number): number =>
    surfaceOffsetEnabled
      ? Math.max(pitch * (0.28 + surfaceOffsetScale * 0.55), cMaxSpan * 0.012)
      : Math.max(pitch * 0.16, cMaxSpan * 0.006);

  // Sample local candidate anchors inside one child instance
  const perInstanceTarget = Math.max(1, Math.floor(targetCount / matrices.length));
  const localAnchors: Vec3[] = [];
  let pitch = cMaxSpan;

  if (perInstanceTarget === 1) {
    const lift = geometryScope === "surface" ? childSurfaceLift(cMaxSpan) : 0;
    const testZ = geometryScope === "surface" ? cCenter[2] + chz - inset : cCenter[2];
    const emitZ = geometryScope === "surface" ? cCenter[2] + chz + lift : cCenter[2];
    if (childTester([cCenter[0], cCenter[1], testZ])) {
      localAnchors.push([cCenter[0], cCenter[1], emitZ]);
    } else {
      // Child center may sit inside a hole; scan a 5x5 local grid for a solid point
      outer: for (let iy = 0; iy < 5; iy += 1) {
        const ly = cCenter[1] - chy + ((iy + 0.5) / 5) * csy;
        for (let ix = 0; ix < 5; ix += 1) {
          const lx = cCenter[0] - chx + ((ix + 0.5) / 5) * csx;
          if (childTester([lx, ly, testZ])) {
            localAnchors.push([lx, ly, emitZ]);
            break outer;
          }
        }
      }
    }
    pitch = Math.max(
      1e-12,
      Math.min(cMaxSpan, Math.max(...object.bounds.size, 1e-12) / Math.sqrt(Math.max(1, targetCount))),
    );
  } else if (geometryScope === "surface") {
    const g = resolveGrid2DCounts(csx, csy, perInstanceTarget);
    pitch = g.pitch;
    const lift = childSurfaceLift(g.pitch);
    const testZ = cCenter[2] + chz - inset;
    const emitZ = cCenter[2] + chz + lift;
    for (let iy = 0; iy < g.nb; iy += 1) {
      const ly = cCenter[1] - chy + ((iy + 0.5) / g.nb) * csy;
      for (let ix = 0; ix < g.na; ix += 1) {
        const lx = cCenter[0] - chx + ((ix + 0.5) / g.na) * csx;
        if (childTester([lx, ly, testZ])) {
          localAnchors.push([lx, ly, emitZ]);
        }
      }
    }
  } else {
    const h = Math.cbrt((csx * csy * csz) / perInstanceTarget);
    const nx = Math.max(1, Math.round(csx / h));
    const ny = Math.max(1, Math.round(csy / h));
    const nz = Math.max(1, Math.round(csz / h));
    pitch = Math.max(1e-12, Math.min(csx / nx, csy / ny, csz / nz));
    for (let iz = 0; iz < nz; iz += 1) {
      const lz = cCenter[2] - chz + ((iz + 0.5) / nz) * csz;
      for (let iy = 0; iy < ny; iy += 1) {
        const ly = cCenter[1] - chy + ((iy + 0.5) / ny) * csy;
        for (let ix = 0; ix < nx; ix += 1) {
          const lx = cCenter[0] - chx + ((ix + 0.5) / nx) * csx;
          if (childTester([lx, ly, lz])) {
            localAnchors.push([lx, ly, lz]);
          }
        }
      }
    }
  }

  if (localAnchors.length === 0) {
    return { positionsWorld: new Float32Array(0), pitch, count: 0, renderOnTop: true };
  }

  const points: number[] = [];
  const v = new Vector3();
  const maxInstToSample =
    matrices.length > targetCount ? targetCount : matrices.length;
  for (let i = 0; i < maxInstToSample; i += 1) {
    const instIdx =
      matrices.length > targetCount
        ? Math.floor((i * matrices.length) / targetCount)
        : i;
    const mat = matrices[instIdx]!;
    for (const anchor of localAnchors) {
      v.set(anchor[0], anchor[1], anchor[2]).applyMatrix4(mat);
      points.push(v.x, v.y, v.z);
    }
  }

  return {
    positionsWorld: new Float32Array(points),
    pitch,
    count: points.length / 3,
    renderOnTop: true,
  };
}

/**
 * Samples an evenly spaced 3D grid of anchor points across a primitive or CSG
 * object's true geometry for authored magnetization vector arrows, honoring
 * `vectorBudget` (clamped 16..2000 when > 0, default 196), `geometryScope`
 * ("surface" vs "full"), `Array3D` instances, and point-in-CSG containment so
 * arrows never float inside cut-out holes or outside solid bounds.
 */
export function buildAuthoredMagnetizationVectorGridPoints(
  object: Viewport3DPrimitiveObject,
  options: AuthoredMagnetizationVectorGridOptions = {},
): AuthoredMagnetizationVectorGrid {
  const rawBudget = options.budget ?? AUTHORED_VECTOR_DEFAULT_BUDGET;
  if (!Number.isFinite(rawBudget) || rawBudget <= 0) {
    return { positionsWorld: new Float32Array(0), pitch: 1e-9, count: 0, renderOnTop: true };
  }
  const targetCount = Math.max(
    AUTHORED_VECTOR_BUDGET_MIN,
    Math.min(AUTHORED_VECTOR_BUDGET_MAX, Math.round(rawBudget)),
  );
  const geometryScope = options.geometryScope ?? "surface";
  const surfaceOffsetEnabled = Boolean(options.surfaceOffsetEnabled);
  const surfaceOffsetScale = Number.isFinite(options.surfaceOffsetScale)
    ? Math.max(0, options.surfaceOffsetScale ?? 0)
    : 0;

  if (object.kind === "array3d" && object.rawGeometry) {
    const arrayed = buildArray3DVectorGridPoints(
      object,
      targetCount,
      geometryScope,
      surfaceOffsetEnabled,
      surfaceOffsetScale,
    );
    if (arrayed) return arrayed;
  }

  const localContainment = resolveObjectLocalContainment(object);
  const [cx, cy, cz] = localContainment ? localContainment.localBounds.center : object.bounds.center;
  const sx = Math.max(
    localContainment ? localContainment.localBounds.size[0] : object.bounds.size[0],
    1e-12,
  );
  const sy = Math.max(
    localContainment ? localContainment.localBounds.size[1] : object.bounds.size[1],
    1e-12,
  );
  const sz = Math.max(
    localContainment ? localContainment.localBounds.size[2] : object.bounds.size[2],
    1e-12,
  );
  const hx = sx * 0.5;
  const hy = sy * 0.5;
  const hz = sz * 0.5;
  const maxSpan = Math.max(sx, sy, sz);
  const inset = Math.min(sx, sy, sz) * 1e-4;
  const points: number[] = [];
  const scratchVec = new Vector3();

  const emitPoint = (testPt: Vec3, emitPt: Vec3): void => {
    if (localContainment) {
      if (!localContainment.tester(testPt)) return;
      scratchVec
        .set(emitPt[0], emitPt[1], emitPt[2])
        .applyMatrix4(localContainment.worldMatrix);
      points.push(scratchVec.x, scratchVec.y, scratchVec.z);
    } else {
      points.push(emitPt[0], emitPt[1], emitPt[2]);
    }
  };

  const innerRingRadiusSq =
    object.kind === "cylinder-cylinder-difference" &&
    object.csgPreview?.kind === "cylinder-cylinder-difference"
      ? object.csgPreview.innerRadius * object.csgPreview.innerRadius
      : 0;
  const insideCylinderCrossSection = (dx: number, dy: number): boolean => {
    const nx = dx / hx;
    const ny = dy / hy;
    if (nx * nx + ny * ny > 1.0001) return false;
    if (innerRingRadiusSq > 0 && dx * dx + dy * dy < innerRingRadiusSq) return false;
    return true;
  };
  const insideEllipsoid = (dx: number, dy: number, dz: number): boolean => {
    const nx = dx / hx;
    const ny = dy / hy;
    const nz = dz / hz;
    return nx * nx + ny * ny + nz * nz <= 1.0001;
  };
  const isZAlignedCylinder =
    (object.kind === "cylinder" || object.kind === "cylinder-cylinder-difference") &&
    (!object.cylinderParams || Math.abs(object.cylinderParams.axis[2]) >= 0.999);

  if (geometryScope === "surface") {
    const surfaceLift = (pitch: number): number =>
      surfaceOffsetEnabled
        ? Math.max(pitch * (0.28 + surfaceOffsetScale * 0.55), maxSpan * 0.012)
        : Math.max(pitch * 0.16, maxSpan * 0.006);

    if (object.kind === "sphere") {
      const approxArea = 4 * Math.PI * ((hx * hy + hy * hz + hz * hx) / 3);
      const pitch = Math.max(1e-12, Math.sqrt(approxArea / targetCount));
      const lift = surfaceLift(pitch);
      const goldenAngle = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < targetCount; i += 1) {
        const y = 1 - ((i + 0.5) / targetCount) * 2;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const theta = goldenAngle * i;
        const ux = Math.cos(theta) * r;
        const uz = Math.sin(theta) * r;
        emitPoint(
          [cx + ux * (hx - inset), cy + y * (hy - inset), cz + uz * (hz - inset)],
          [cx + ux * (hx + lift), cy + y * (hy + lift), cz + uz * (hz + lift)],
        );
      }
      return {
        positionsWorld: new Float32Array(points),
        pitch,
        count: points.length / 3,
        renderOnTop: false,
      };
    }

    if (isZAlignedCylinder) {
      const isThinDisk = sz <= 0.35 * Math.max(sx, sy);
      if (isThinDisk) {
        const { na, nb, pitch } = resolveGrid2DCounts(sx, sy, Math.round(targetCount * (4 / Math.PI)));
        const lift = surfaceLift(pitch);
        const testZ = cz + hz - inset;
        const emitZ = cz + hz + lift;
        for (let iy = 0; iy < nb; iy += 1) {
          const dy = -hy + ((iy + 0.5) / nb) * sy;
          for (let ix = 0; ix < na; ix += 1) {
            const dx = -hx + ((ix + 0.5) / na) * sx;
            if (insideCylinderCrossSection(dx, dy)) {
              emitPoint([cx + dx, cy + dy, testZ], [cx + dx, cy + dy, emitZ]);
            }
          }
        }
        return {
          positionsWorld: new Float32Array(points),
          pitch,
          count: points.length / 3,
          renderOnTop: true,
        };
      }
      // Thick cylinder: sample top/bottom caps + cylindrical mantle
      const capBudget = Math.max(4, Math.round(targetCount * 0.25));
      const mantleBudget = Math.max(8, targetCount - capBudget * 2);
      const capGrid = resolveGrid2DCounts(sx, sy, Math.round(capBudget * (4 / Math.PI)));
      const circumference = Math.PI * (hx + hy);
      const mantleGrid = resolveGrid2DCounts(circumference, sz, mantleBudget);
      const pitch = Math.min(capGrid.pitch, mantleGrid.pitch);
      const lift = surfaceLift(pitch);
      for (const zSign of [1, -1] as const) {
        const testZ = cz + zSign * (hz - inset);
        const emitZ = cz + zSign * (hz + lift);
        for (let iy = 0; iy < capGrid.nb; iy += 1) {
          const dy = -hy + ((iy + 0.5) / capGrid.nb) * sy;
          for (let ix = 0; ix < capGrid.na; ix += 1) {
            const dx = -hx + ((ix + 0.5) / capGrid.na) * sx;
            if (insideCylinderCrossSection(dx, dy)) {
              emitPoint([cx + dx, cy + dy, testZ], [cx + dx, cy + dy, emitZ]);
            }
          }
        }
      }
      for (let iz = 0; iz < mantleGrid.nb; iz += 1) {
        const z = cz - hz + ((iz + 0.5) / mantleGrid.nb) * sz;
        for (let it = 0; it < mantleGrid.na; it += 1) {
          const theta = (2 * Math.PI * it) / mantleGrid.na;
          const cosT = Math.cos(theta);
          const sinT = Math.sin(theta);
          emitPoint(
            [cx + cosT * (hx - inset), cy + sinT * (hy - inset), z],
            [cx + cosT * (hx + lift), cy + sinT * (hy + lift), z],
          );
        }
      }
      return {
        positionsWorld: new Float32Array(points),
        pitch,
        count: points.length / 3,
        renderOnTop: false,
      };
    }

    // Box / CSG / general primitive surface sampling
    const thinZ = sz <= 0.35 * Math.max(sx, sy);
    const thinY = !thinZ && sy <= 0.35 * Math.max(sx, sz);
    const thinX = !thinZ && !thinY && sx <= 0.35 * Math.max(sy, sz);
    let computedPitch = maxSpan;
    let renderOnTop = true;

    if (thinZ) {
      const { na, nb, pitch } = resolveGrid2DCounts(sx, sy, targetCount);
      computedPitch = pitch;
      const testZ = cz + hz - inset;
      const emitZ = cz + hz + surfaceLift(pitch);
      for (let iy = 0; iy < nb; iy += 1) {
        const y = cy - hy + ((iy + 0.5) / nb) * sy;
        for (let ix = 0; ix < na; ix += 1) {
          const x = cx - hx + ((ix + 0.5) / na) * sx;
          emitPoint([x, y, testZ], [x, y, emitZ]);
        }
      }
    } else if (thinY) {
      const { na, nb, pitch } = resolveGrid2DCounts(sx, sz, targetCount);
      computedPitch = pitch;
      const testY = cy + hy - inset;
      const emitY = cy + hy + surfaceLift(pitch);
      for (let iz = 0; iz < nb; iz += 1) {
        const z = cz - hz + ((iz + 0.5) / nb) * sz;
        for (let ix = 0; ix < na; ix += 1) {
          const x = cx - hx + ((ix + 0.5) / na) * sx;
          emitPoint([x, testY, z], [x, emitY, z]);
        }
      }
    } else if (thinX) {
      const { na, nb, pitch } = resolveGrid2DCounts(sy, sz, targetCount);
      computedPitch = pitch;
      const testX = cx + hx - inset;
      const emitX = cx + hx + surfaceLift(pitch);
      for (let iz = 0; iz < nb; iz += 1) {
        const z = cz - hz + ((iz + 0.5) / nb) * sz;
        for (let iy = 0; iy < na; iy += 1) {
          const y = cy - hy + ((iy + 0.5) / na) * sy;
          emitPoint([testX, y, z], [emitX, y, z]);
        }
      }
    } else {
      // Thick 3D shape: distribute across all 6 AABB faces proportional to area
      renderOnTop = false;
      const totalArea = 2 * (sx * sy + sy * sz + sz * sx);
      const basePitch = Math.max(1e-12, Math.sqrt(totalArea / targetCount));
      const lift = surfaceLift(basePitch);
      const nx = Math.max(1, Math.round(sx / basePitch));
      const ny = Math.max(1, Math.round(sy / basePitch));
      const nz = Math.max(1, Math.round(sz / basePitch));
      computedPitch = Math.max(1e-12, Math.min(sx / nx, sy / ny, sz / nz));
      // ±Z faces
      for (const zSign of [1, -1] as const) {
        const testZ = cz + zSign * (hz - inset);
        const emitZ = cz + zSign * (hz + lift);
        for (let iy = 0; iy < ny; iy += 1) {
          const y = cy - hy + ((iy + 0.5) / ny) * sy;
          for (let ix = 0; ix < nx; ix += 1) {
            const x = cx - hx + ((ix + 0.5) / nx) * sx;
            emitPoint([x, y, testZ], [x, y, emitZ]);
          }
        }
      }
      // ±Y faces
      for (const ySign of [1, -1] as const) {
        const testY = cy + ySign * (hy - inset);
        const emitY = cy + ySign * (hy + lift);
        for (let iz = 0; iz < nz; iz += 1) {
          const z = cz - hz + ((iz + 0.5) / nz) * sz;
          for (let ix = 0; ix < nx; ix += 1) {
            const x = cx - hx + ((ix + 0.5) / nx) * sx;
            emitPoint([x, testY, z], [x, emitY, z]);
          }
        }
      }
      // ±X faces
      for (const xSign of [1, -1] as const) {
        const testX = cx + xSign * (hx - inset);
        const emitX = cx + xSign * (hx + lift);
        for (let iz = 0; iz < nz; iz += 1) {
          const z = cz - hz + ((iz + 0.5) / nz) * sz;
          for (let iy = 0; iy < ny; iy += 1) {
            const y = cy - hy + ((iy + 0.5) / ny) * sy;
            emitPoint([testX, y, z], [emitX, y, z]);
          }
        }
      }
    }

    // For curved/stepped 3D composites (Torus, Cone, Ellipsoid, non-Z Cylinder, stepped Union)
    // where AABB outer faces miss most of the true surface, sample the triangulated surface directly.
    const minAcceptableFaceCount = Math.min(8, Math.max(1, Math.floor(targetCount * 0.25)));
    if (
      points.length / 3 < minAcceptableFaceCount &&
      (object.kind === "composite" ||
        (object.kind === "cylinder" && !isZAlignedCylinder))
    ) {
      const fallback = sampleCompositeSurfaceVectorAnchors(object, targetCount, surfaceLift);
      if (fallback && fallback.count > points.length / 3) {
        return {
          positionsWorld: fallback.positionsWorld,
          pitch: fallback.pitch,
          count: fallback.count,
          renderOnTop: false,
        };
      }
    }

    return {
      positionsWorld: new Float32Array(points),
      pitch: computedPitch,
      count: points.length / 3,
      renderOnTop,
    };
  }

  // Full volume sampling
  const oversample =
    object.kind === "sphere"
      ? 6 / Math.PI
      : object.kind === "cylinder" || object.kind === "cylinder-cylinder-difference"
        ? 4 / Math.PI
        : 1;
  const effTarget = Math.max(1, Math.round(targetCount * oversample));
  const h = Math.cbrt((sx * sy * sz) / effTarget);
  let nx = Math.max(1, Math.round(sx / h));
  let ny = Math.max(1, Math.round(sy / h));
  let nz = Math.max(1, Math.round(sz / h));

  // If thin along one axis (clamped to 1), redistribute the 2D plane nicely
  if (nz === 1 && nx * ny < effTarget * 0.7) {
    const g = resolveGrid2DCounts(sx, sy, effTarget);
    nx = g.na;
    ny = g.nb;
  } else if (ny === 1 && nx * nz < effTarget * 0.7) {
    const g = resolveGrid2DCounts(sx, sz, effTarget);
    nx = g.na;
    nz = g.nb;
  } else if (nx === 1 && ny * nz < effTarget * 0.7) {
    const g = resolveGrid2DCounts(sy, sz, effTarget);
    ny = g.na;
    nz = g.nb;
  }

  while (nx * ny * nz > effTarget && (nx > 1 || ny > 1 || nz > 1)) {
    const rx = nx > 1 ? nx / sx : -1;
    const ry = ny > 1 ? ny / sy : -1;
    const rz = nz > 1 ? nz / sz : -1;
    if (rx >= ry && rx >= rz) nx -= 1;
    else if (ry >= rz) ny -= 1;
    else nz -= 1;
  }

  for (let iz = 0; iz < nz; iz += 1) {
    const dz = -hz + ((iz + 0.5) / nz) * sz;
    for (let iy = 0; iy < ny; iy += 1) {
      const dy = -hy + ((iy + 0.5) / ny) * sy;
      for (let ix = 0; ix < nx; ix += 1) {
        const dx = -hx + ((ix + 0.5) / nx) * sx;
        if (!localContainment) {
          if (isZAlignedCylinder && !insideCylinderCrossSection(dx, dy)) {
            continue;
          }
          if (object.kind === "sphere" && !insideEllipsoid(dx, dy, dz)) {
            continue;
          }
        }
        const pt: Vec3 = [cx + dx, cy + dy, cz + dz];
        emitPoint(pt, pt);
      }
    }
  }

  const activeSpacings: number[] = [];
  if (nx > 1) activeSpacings.push(sx / nx);
  if (ny > 1) activeSpacings.push(sy / ny);
  if (nz > 1) activeSpacings.push(sz / nz);
  const pitch = Math.max(
    1e-12,
    activeSpacings.length > 0 ? Math.min(...activeSpacings) : maxSpan,
  );

  return {
    positionsWorld: new Float32Array(points),
    pitch,
    count: points.length / 3,
    renderOnTop: true,
  };
}

export interface AuthoredMagnetizationArrowBuffersOptions {
  readonly colorMode?: string;
  readonly monoColor?: ColorRepresentation;
  readonly fallbackMonoColor?: ColorRepresentation;
  readonly scalarColorPalette?: string;
  readonly lengthScale?: number;
  readonly centeringEnabled?: boolean;
}

export interface AuthoredMagnetizationArrowBuffers {
  readonly positions: Float32Array;
  readonly colors: Float32Array;
  readonly arrowCount: number;
}

function resolveLinearMonoRgb(
  monoColor: ColorRepresentation | undefined,
  fallbackMonoColor: ColorRepresentation | undefined,
): [number, number, number] {
  const candidates: Array<ColorRepresentation | undefined> = [
    monoColor,
    fallbackMonoColor,
    0x38bdf8,
  ];
  const parsed = new Color();
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (!trimmed || trimmed.startsWith("var(")) continue;
      try {
        parsed.set(trimmed);
        return [parsed.r, parsed.g, parsed.b];
      } catch {
        continue;
      }
    }
    try {
      parsed.set(candidate);
      return [parsed.r, parsed.g, parsed.b];
    } catch {
      // Try next fallback candidate
    }
  }
  return [0.04, 0.5, 0.9];
}

function resolveAuthoredArrowLinearRgb(
  ux: number,
  uy: number,
  uz: number,
  magnitude: number,
  colorMode: string,
  scalarColorPalette: string,
  monoRgb: readonly [number, number, number],
): [number, number, number] {
  const normalizedMode = normalizeViewport3DVectorColorMode(colorMode, "orientation");
  switch (normalizedMode) {
    case "monochrome":
      return [monoRgb[0], monoRgb[1], monoRgb[2]];
    case "x":
      return scalarColorRgb((ux + 1) * 0.5, scalarColorPalette);
    case "y":
      return scalarColorRgb((uy + 1) * 0.5, scalarColorPalette);
    case "z":
      return scalarColorRgb((uz + 1) * 0.5, scalarColorPalette);
    case "magnitude":
      return scalarColorRgb(Math.min(1, Math.max(0, magnitude)), scalarColorPalette);
    case "orientation":
    default:
      return magnetizationHslLinearRgb(ux, uy, uz);
  }
}

export interface AuthoredMagnetizationArrowSegmentsOptions {
  readonly lengthScale?: number;
  readonly centeringEnabled?: boolean;
}

export interface AuthoredMagnetizationArrowGlyphOptions
  extends AuthoredMagnetizationArrowSegmentsOptions {
  readonly colorMode?: string;
  readonly monoColor?: ColorRepresentation;
  readonly fallbackMonoColor?: ColorRepresentation;
  readonly scalarColorPalette?: string;
  readonly thickness?: number;
}

export interface AuthoredMagnetizationArrowGlyphData {
  readonly segments: Float32Array;
  readonly transforms: VectorGlyphTransforms;
  readonly colors: Float32Array;
  readonly arrowCount: number;
}

function clampAuthoredVectorThickness(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.min(AUTHORED_VECTOR_THICKNESS_MAX, Math.max(AUTHORED_VECTOR_THICKNESS_MIN, value));
}

function resolveAuthoredVectorCapacity(count: number): number {
  const desired = Math.max(1, count);
  let next = 1;
  while (next < desired) next *= 2;
  return Math.min(next, 1 << 16);
}

/**
 * Builds 7-channel vector segments `[sx, sy, sz, ex, ey, ez, relMag]` from sampled
 * world anchor points and magnetization vectors for instanced 3D cylinder+cone arrows.
 */
export function buildAuthoredMagnetizationArrowSegments(
  positionsWorld: Float32Array,
  sampledVectors: Float32Array,
  pitch: number,
  options: AuthoredMagnetizationArrowSegmentsOptions = {},
): Float32Array {
  const count = Math.min(
    Math.floor(positionsWorld.length / 3),
    Math.floor(sampledVectors.length / 3),
  );
  if (count <= 0) {
    return new Float32Array(0);
  }

  const lengthScale = Math.min(
    5,
    Math.max(0.1, Number.isFinite(options.lengthScale) ? (options.lengthScale ?? 1) : 1),
  );
  const centeringEnabled = options.centeringEnabled ?? true;
  const arrowLen = Math.max(pitch * AUTHORED_ARROW_LENGTH_FACTOR * lengthScale, 1e-12);

  const segments = new Float32Array(count * 7);
  let emitted = 0;

  for (let i = 0; i < count; i += 1) {
    const base = i * 3;
    const ax = positionsWorld[base]!;
    const ay = positionsWorld[base + 1]!;
    const az = positionsWorld[base + 2]!;
    const vx = sampledVectors[base]!;
    const vy = sampledVectors[base + 1]!;
    const vz = sampledVectors[base + 2]!;
    const mag = Math.hypot(vx, vy, vz);
    if (!Number.isFinite(mag) || mag < 1e-9) continue;

    const ux = vx / mag;
    const uy = vy / mag;
    const uz = vz / mag;

    const sx = centeringEnabled ? ax - ux * (arrowLen * 0.5) : ax;
    const sy = centeringEnabled ? ay - uy * (arrowLen * 0.5) : ay;
    const sz = centeringEnabled ? az - uz * (arrowLen * 0.5) : az;
    const ex = sx + ux * arrowLen;
    const ey = sy + uy * arrowLen;
    const ez = sz + uz * arrowLen;

    const out = emitted * 7;
    segments[out] = sx;
    segments[out + 1] = sy;
    segments[out + 2] = sz;
    segments[out + 3] = ex;
    segments[out + 4] = ey;
    segments[out + 5] = ez;
    segments[out + 6] = Math.min(1, Math.max(0, mag));
    emitted += 1;
  }

  return emitted === count ? segments : segments.subarray(0, emitted * 7);
}

/**
 * Computes per-instance linear-sRGB colors (`count * 3`) for Three.js `instanceColor`
 * across orientation (HSL wheel), monochrome, magnitude, and x/y/z scalar palette modes.
 */
export function buildAuthoredMagnetizationArrowInstanceColors(
  segments: Float32Array,
  options: Pick<
    AuthoredMagnetizationArrowGlyphOptions,
    "colorMode" | "monoColor" | "fallbackMonoColor" | "scalarColorPalette"
  > = {},
): Float32Array {
  const stride = segments.length > 0 && segments.length % 7 === 0 ? 7 : 6;
  const count = Math.floor(segments.length / stride);
  if (count <= 0) {
    return new Float32Array(0);
  }

  const colorMode = normalizeViewport3DVectorColorMode(options.colorMode, "orientation");
  const scalarColorPalette = options.scalarColorPalette ?? "coolwarm";
  const monoRgb = resolveLinearMonoRgb(options.monoColor, options.fallbackMonoColor);
  const colors = new Float32Array(count * 3);

  for (let i = 0; i < count; i += 1) {
    const src = i * stride;
    const dx = (segments[src + 3] ?? 0) - (segments[src] ?? 0);
    const dy = (segments[src + 4] ?? 0) - (segments[src + 1] ?? 0);
    const dz = (segments[src + 5] ?? 0) - (segments[src + 2] ?? 0);
    const len = Math.hypot(dx, dy, dz);
    const ux = len > 0 ? dx / len : 0;
    const uy = len > 0 ? dy / len : 1;
    const uz = len > 0 ? dz / len : 0;
    const relMag = stride >= 7 ? (segments[src + 6] ?? 1) : 1;
    const [r, g, b] = resolveAuthoredArrowLinearRgb(
      ux,
      uy,
      uz,
      relMag,
      colorMode,
      scalarColorPalette,
      monoRgb,
    );
    const dst = i * 3;
    colors[dst] = r;
    colors[dst + 1] = g;
    colors[dst + 2] = b;
  }

  return colors;
}

/**
 * Builds 3D solid instanced arrow transforms (shaft cylinder + cone head) and
 * linear-RGB per-instance colors matching Fullmag's native `VectorFieldLayer`.
 */
export function buildAuthoredMagnetizationArrowGlyphData(
  positionsWorld: Float32Array,
  sampledVectors: Float32Array,
  pitch: number,
  options: AuthoredMagnetizationArrowGlyphOptions = {},
): AuthoredMagnetizationArrowGlyphData {
  const segments = buildAuthoredMagnetizationArrowSegments(
    positionsWorld,
    sampledVectors,
    pitch,
    options,
  );
  const thickness = clampAuthoredVectorThickness(options.thickness);
  const transforms = buildVectorGlyphTransforms(segments, {
    headLengthRatio: AUTHORED_ARROW_HEAD_LENGTH_RATIO,
    headRadiusRatio: AUTHORED_ARROW_HEAD_RADIUS_RATIO * thickness,
    shaftRadiusRatio: AUTHORED_ARROW_SHAFT_RADIUS_RATIO * thickness,
  });
  const colors = buildAuthoredMagnetizationArrowInstanceColors(segments, options);
  return {
    segments,
    transforms,
    colors,
    arrowCount: transforms.count,
  };
}

/**
 * Builds vertex-colored `<lineSegments>` buffers (shaft + 2-segment arrowhead
 * chevron = 3 segments / 6 vertices per arrow) from sampled world anchor points
 * and magnetization vectors.
 */
export function buildAuthoredMagnetizationArrowBuffers(
  positionsWorld: Float32Array,
  vectors: Float32Array,
  pitch: number,
  options: AuthoredMagnetizationArrowBuffersOptions = {},
): AuthoredMagnetizationArrowBuffers {
  const count = Math.min(
    Math.floor(positionsWorld.length / 3),
    Math.floor(vectors.length / 3),
  );
  if (count <= 0) {
    return {
      positions: new Float32Array(0),
      colors: new Float32Array(0),
      arrowCount: 0,
    };
  }

  const colorMode = (options.colorMode ?? "orientation").toLowerCase();
  const scalarColorPalette = options.scalarColorPalette ?? "coolwarm";
  const monoRgb = resolveLinearMonoRgb(options.monoColor, options.fallbackMonoColor);
  const lengthScale = Math.min(
    5,
    Math.max(0.1, Number.isFinite(options.lengthScale) ? (options.lengthScale ?? 1) : 1),
  );
  const centeringEnabled = options.centeringEnabled ?? true;
  const arrowLen = Math.max(pitch * AUTHORED_ARROW_LENGTH_FACTOR * lengthScale, 1e-12);
  const headLen = arrowLen * 0.3;
  const headHalfWidth = arrowLen * 0.16;

  // 3 segments * 2 vertices * 3 floats = 18 floats per arrow
  const outPositions = new Float32Array(count * 18);
  const outColors = new Float32Array(count * 18);
  let emitted = 0;

  for (let i = 0; i < count; i += 1) {
    const base = i * 3;
    const ax = positionsWorld[base]!;
    const ay = positionsWorld[base + 1]!;
    const az = positionsWorld[base + 2]!;
    const vx = vectors[base]!;
    const vy = vectors[base + 1]!;
    const vz = vectors[base + 2]!;
    const mag = Math.hypot(vx, vy, vz);
    if (!Number.isFinite(mag) || mag < 1e-9) continue;

    const ux = vx / mag;
    const uy = vy / mag;
    const uz = vz / mag;

    const tailX = centeringEnabled ? ax - ux * (arrowLen * 0.5) : ax;
    const tailY = centeringEnabled ? ay - uy * (arrowLen * 0.5) : ay;
    const tailZ = centeringEnabled ? az - uz * (arrowLen * 0.5) : az;
    const tipX = tailX + ux * arrowLen;
    const tipY = tailY + uy * arrowLen;
    const tipZ = tailZ + uz * arrowLen;

    // Perpendicular vector in plane for crisp chevron wings
    const refX = Math.abs(uz) < 0.9 ? 0 : 1;
    const refY = 0;
    const refZ = Math.abs(uz) < 0.9 ? 1 : 0;
    const px = uy * refZ - uz * refY;
    const py = uz * refX - ux * refZ;
    const pz = ux * refY - uy * refX;
    const pLen = Math.hypot(px, py, pz) || 1;
    const wx = (px / pLen) * headHalfWidth;
    const wy = (py / pLen) * headHalfWidth;
    const wz = (pz / pLen) * headHalfWidth;

    const wingBaseX = tipX - ux * headLen;
    const wingBaseY = tipY - uy * headLen;
    const wingBaseZ = tipZ - uz * headLen;

    const [r, g, b] = resolveAuthoredArrowLinearRgb(
      ux,
      uy,
      uz,
      mag,
      colorMode,
      scalarColorPalette,
      monoRgb,
    );

    const out = emitted * 18;
    // Segment 1: shaft (tail -> tip)
    outPositions[out] = tailX;
    outPositions[out + 1] = tailY;
    outPositions[out + 2] = tailZ;
    outPositions[out + 3] = tipX;
    outPositions[out + 4] = tipY;
    outPositions[out + 5] = tipZ;
    // Segment 2: left chevron wing (tip -> wingA)
    outPositions[out + 6] = tipX;
    outPositions[out + 7] = tipY;
    outPositions[out + 8] = tipZ;
    outPositions[out + 9] = wingBaseX + wx;
    outPositions[out + 10] = wingBaseY + wy;
    outPositions[out + 11] = wingBaseZ + wz;
    // Segment 3: right chevron wing (tip -> wingB)
    outPositions[out + 12] = tipX;
    outPositions[out + 13] = tipY;
    outPositions[out + 14] = tipZ;
    outPositions[out + 15] = wingBaseX - wx;
    outPositions[out + 16] = wingBaseY - wy;
    outPositions[out + 17] = wingBaseZ - wz;

    for (let v = 0; v < 6; v += 1) {
      outColors[out + v * 3] = r;
      outColors[out + v * 3 + 1] = g;
      outColors[out + v * 3 + 2] = b;
    }
    emitted += 1;
  }

  return {
    positions: emitted === count ? outPositions : outPositions.subarray(0, emitted * 18),
    colors: emitted === count ? outColors : outColors.subarray(0, emitted * 18),
    arrowCount: emitted,
  };
}

export function createViewport3DTextureTransformModel(scene: SceneResource | null) {
  return {
    getAuthoredDraft(objectId: string) {
      if (!scene) return null;
      const bounds = resolveTargetBoundsMeters(scene, { kind: "object", objectId });
      const sceneObject = scene.objects?.find((entry) => entry.id === objectId);
      const asset = scene.magnetization_assets?.find(
        (entry) => entry.id === sceneObject?.magnetization_ref,
      );
      const draft = hydrateMagneticTextureDraftFromInitializer(asset, bounds, "object");
      return { draft, bounds };
    },
    /**
     * Returns true when the object has a committed authored magnetization texture
     * that is NOT an external field-file reference. Used to decide whether to render
     * a persistent surface preview even when the Magnetic Texture editor is not active.
     */
    hasAuthoredMagnetization(objectId: string): boolean {
      if (!scene) return false;
      const sceneObjects = scene.objects;
      if (!Array.isArray(sceneObjects)) return false;
      const sceneObject = sceneObjects.find(
        (entry) => typeof entry === "object" && entry !== null && (entry as Record<string, unknown>).id === objectId,
      ) as Record<string, unknown> | undefined;
      if (!sceneObject) return false;
      // Check enabled authored region texture_override.initial_magnetization
      const regions = sceneObject.regions;
      if (Array.isArray(regions)) {
        for (const region of regions) {
          if (typeof region !== "object" || region === null) continue;
          const r = region as Record<string, unknown>;
          if (r.enabled === false) continue;
          const textureOverride = r.texture_override as Record<string, unknown> | undefined;
          if (
            textureOverride &&
            typeof textureOverride.initial_magnetization === "object" &&
            textureOverride.initial_magnetization !== null
          ) {
            return true;
          }
        }
      }
      // Check object-level magnetization_ref → asset (excluding field-file)
      const refId = sceneObject.magnetization_ref;
      if (!refId || typeof refId !== "string") return false;
      const assets = scene.magnetization_assets;
      if (!Array.isArray(assets)) return false;
      const asset = assets.find(
        (a) => typeof a === "object" && a !== null && (a as Record<string, unknown>).id === refId,
      ) as Record<string, unknown> | undefined;
      if (!asset) return false;
      const assetKind = typeof asset.kind === "string" ? asset.kind : "";
      if (assetKind === "field_file" || assetKind === "field-file" || assetKind === "imported_field") {
        return false;
      }
      return asset.source_mode !== "field-file";
    },
    sampleSurfaceColors(options: Omit<SampleViewport3DSurfaceHslOptions, "scene">) {
      try {
        return sampleViewport3DSurfaceHslColors({ ...options, scene });
      } catch {
        return null;
      }
    },
    sampleVectors(options: Omit<SampleAuthoredMagnetizationVectorsOptions, "scene">) {
      try {
        return sampleAuthoredMagnetizationVectors({ ...options, scene });
      } catch {
        return null;
      }
    },
  };
}

export type Viewport3DTextureTransformModel = ReturnType<typeof createViewport3DTextureTransformModel>;

function TextureGizmoInteractiveHandles({
  colors,
  draft,
  gizmoMode,
  invalidate,
  objectId,
  onGestureActiveChange,
  pose,
  proxyGeometry,
}: {
  colors: Viewport3DColors;
  draft: MagneticTextureDraft;
  gizmoMode: GizmoHandleMode;
  invalidate: () => void;
  objectId: string;
  onGestureActiveChange?: (active: boolean) => void;
  pose: TextureGizmoWorldPose;
  proxyGeometry: BufferGeometry | null;
}) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { enabled?: boolean } | null;

  const gizmoGroupRef = useRef<Group>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const hoveredKeyRef = useRef<string | null>(null);

  const [dragController] = useState(() => createTextureGizmoDragController());

  useLayoutEffect(() => {
    dragController.syncContext({
      camera,
      canvas: gl?.domElement ?? null,
      controls,
      draft,
      pose,
      windowTarget: typeof window === "undefined" ? null : window,
      onGestureActiveChange,
      onActiveKeyChange: setActiveKey,
      invalidate,
    });
  }, [camera, controls, draft, dragController, gl, invalidate, onGestureActiveChange, pose]);

  useEffect(
    () => () => {
      dragController.dispose();
      if (hoveredKeyRef.current !== null && gl?.domElement?.style) {
        gl.domElement.style.cursor = "";
      }
    },
    [dragController, gl],
  );

  useEffect(() => {
    const canvas = gl?.domElement;
    if (!canvas?.addEventListener) return undefined;
    const ndc = new Vector2();
    const raycaster = new Raycaster();

    const updateHoverKey = (nextKey: string | null) => {
      if (hoveredKeyRef.current === nextKey) return;
      hoveredKeyRef.current = nextKey;
      setHoveredKey(nextKey);
      if (!dragController.isActive() && canvas.style) {
        canvas.style.cursor = nextKey ? "grab" : "";
      }
      invalidate();
    };

    const raycastCanvasEvent = (event: MouseEvent): PickedTextureGizmoTarget | null => {
      const group = gizmoGroupRef.current;
      if (!group) return null;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      ndc.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      camera.updateMatrixWorld();
      raycaster.setFromCamera(ndc, camera);
      return pickTextureGizmoHandleFromGroup(group, raycaster);
    };

    const onCanvasPointerMove = (event: PointerEvent) => {
      if (dragController.isActive()) return;
      const picked = raycastCanvasEvent(event);
      updateHoverKey(
        picked?.kind === "handle"
          ? picked.key
          : picked?.kind === "center-anchor"
            ? "center-anchor"
            : null,
      );
    };

    const onCanvasPointerLeave = () => {
      if (dragController.isActive()) return;
      updateHoverKey(null);
    };

    const onCanvasPointerDownCapture = (event: PointerEvent) => {
      if (event.button !== 0 || dragController.isActive()) return;
      const picked = raycastCanvasEvent(event);
      if (!picked) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (picked.kind === "center-anchor") {
        if (event.detail >= 2) {
          patchActiveTextureDraft({ translationM: [0, 0, 0] });
          invalidate();
        }
        return;
      }

      dragController.beginDrag({
        pointerId: event.pointerId,
        mode: picked.mode,
        handle: picked.handle,
        key: picked.key,
        ray: raycaster.ray,
        hitPoint: picked.point,
      });
    };

    const onCanvasDblClickCapture = (event: MouseEvent) => {
      const picked = raycastCanvasEvent(event);
      if (picked?.kind !== "center-anchor") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      patchActiveTextureDraft({ translationM: [0, 0, 0] });
      invalidate();
    };

    canvas.addEventListener("pointerdown", onCanvasPointerDownCapture, { capture: true });
    canvas.addEventListener("dblclick", onCanvasDblClickCapture, { capture: true });
    canvas.addEventListener("pointermove", onCanvasPointerMove);
    canvas.addEventListener("pointerleave", onCanvasPointerLeave);

    return () => {
      canvas.removeEventListener("pointerdown", onCanvasPointerDownCapture, { capture: true });
      canvas.removeEventListener("dblclick", onCanvasDblClickCapture, { capture: true });
      canvas.removeEventListener("pointermove", onCanvasPointerMove);
      canvas.removeEventListener("pointerleave", onCanvasPointerLeave);
    };
  }, [camera, dragController, gl, invalidate]);

  const L = pose.handleLength;
  const shaftRadius = Math.max(L * 0.032, 1e-12);
  const hitboxRadius = shaftRadius * 3.5;
  const tipSize = Math.max(L * 0.11, 1e-12);
  const coneRadius = Math.max(shaftRadius * 2.6, tipSize * 0.78);
  const coneHeight = Math.max(tipSize * 1.9, L * 0.22);

  const xColor = colors.hud?.axisX ?? colors.danger ?? colors.accent;
  const yColor = colors.hud?.axisY ?? colors.success ?? colors.field;
  const zColor = colors.hud?.axisZ ?? colors.accent;
  const highlightColor = colors.textPrimary ?? colors.field;

  const isHighlighted = (key: string) => activeKey === key || hoveredKey === key;

  const handleR3FPointerDown = (
    descriptor: GizmoHandleDescriptor,
    event: ThreeEvent<PointerEvent>,
  ) => {
    event.stopPropagation();
    event.nativeEvent?.stopImmediatePropagation?.();
    if (dragController.isActive()) return;
    dragController.beginDrag({
      pointerId: event.pointerId,
      mode: descriptor.mode,
      handle: descriptor.handle,
      key: descriptor.key,
      ray: event.ray,
      hitPoint: extractEventPoint(event, pose.originWorld),
    });
  };

  return (
    <group
      name={`texture-gizmo:${objectId}`}
      position={pose.originWorld}
      ref={gizmoGroupRef}
      userData={{
        gizmo: "texture-transform",
        mode: gizmoMode,
        objectId,
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

      {gizmoMode !== "scale" ? (
        <mesh
          onDoubleClick={(event) => {
            event.stopPropagation();
            patchActiveTextureDraft({ translationM: [0, 0, 0] });
            invalidate();
          }}
          renderOrder={RENDER_POLICIES.selectionShell.renderOrder + 2}
          userData={{ gizmo: "texture-center-anchor" }}
        >
          <sphereGeometry
            args={[tipSize * (hoveredKey === "center-anchor" ? 0.72 : 0.6), 16, 12]}
          />
          <meshBasicMaterial color={highlightColor} depthTest={false} toneMapped={false} />
        </mesh>
      ) : null}

      {gizmoMode === "translate" ? (
        <group userData={{ gizmoMode: "translate" }}>
          {(
            [
              {
                axis: "x" as const,
                shaftPos: [L * 0.45, 0, 0] as Vec3,
                conePos: [L, 0, 0] as Vec3,
                hitboxPos: [L * 0.58, 0, 0] as Vec3,
                rot: [0, 0, -Math.PI / 2] as Vec3,
                color: xColor,
              },
              {
                axis: "y" as const,
                shaftPos: [0, L * 0.45, 0] as Vec3,
                conePos: [0, L, 0] as Vec3,
                hitboxPos: [0, L * 0.58, 0] as Vec3,
                rot: [0, 0, 0] as Vec3,
                color: yColor,
              },
              {
                axis: "z" as const,
                shaftPos: [0, 0, L * 0.45] as Vec3,
                conePos: [0, 0, L] as Vec3,
                hitboxPos: [0, 0, L * 0.58] as Vec3,
                rot: [Math.PI / 2, 0, 0] as Vec3,
                color: zColor,
              },
            ] as const
          ).map(({ axis, shaftPos, conePos, hitboxPos, rot, color }) => {
            const key = `translate:${axis}`;
            const descriptor: GizmoHandleDescriptor = {
              mode: "translate",
              handle: axis,
              key,
              priority: 1,
            };
            const active = isHighlighted(key);
            const activeColor = active ? highlightColor : color;
            const radiusScale = active ? 1.25 : 1;
            return (
              <group key={axis}>
                <mesh
                  onPointerDown={(e) => handleR3FPointerDown(descriptor, e)}
                  position={shaftPos}
                  renderOrder={RENDER_POLICIES.selectionShell.renderOrder + 1}
                  rotation={rot}
                  userData={{ axis, gizmo: "texture-translate-axis", gizmoHandle: descriptor }}
                >
                  <cylinderGeometry
                    args={[shaftRadius * radiusScale, shaftRadius * radiusScale, L * 0.9, 14]}
                  />
                  <meshBasicMaterial color={activeColor} depthTest={false} toneMapped={false} />
                </mesh>
                <mesh
                  onPointerDown={(e) => handleR3FPointerDown(descriptor, e)}
                  position={conePos}
                  renderOrder={RENDER_POLICIES.selectionShell.renderOrder + 2}
                  rotation={rot}
                  userData={{ axis, gizmo: "texture-translate-cone", gizmoHandle: descriptor }}
                >
                  <coneGeometry args={[coneRadius * radiusScale, coneHeight, 16]} />
                  <meshBasicMaterial color={activeColor} depthTest={false} toneMapped={false} />
                </mesh>
                <mesh
                  onPointerDown={(e) => handleR3FPointerDown(descriptor, e)}
                  position={hitboxPos}
                  renderOrder={RENDER_POLICIES.selectionShell.renderOrder + 3}
                  rotation={rot}
                  userData={{ axis, gizmo: "texture-translate-hitbox", gizmoHandle: descriptor }}
                >
                  <cylinderGeometry args={[hitboxRadius, hitboxRadius, L * 1.05, 12]} />
                  <meshBasicMaterial depthTest={false} depthWrite={false} opacity={0} transparent />
                </mesh>
              </group>
            );
          })}
          {(
            [
              { plane: "xy" as const, pos: [L * 0.25, L * 0.25, 0] as Vec3, rot: [0, 0, 0] as Vec3, color: zColor },
              { plane: "xz" as const, pos: [L * 0.25, 0, L * 0.25] as Vec3, rot: [Math.PI / 2, 0, 0] as Vec3, color: yColor },
              { plane: "yz" as const, pos: [0, L * 0.25, L * 0.25] as Vec3, rot: [0, Math.PI / 2, 0] as Vec3, color: xColor },
            ] as const
          ).map(({ plane, pos, rot, color }) => {
            const key = `translate:${plane}`;
            const descriptor: GizmoHandleDescriptor = {
              mode: "translate",
              handle: plane,
              key,
              priority: 2,
            };
            const active = isHighlighted(key);
            return (
              <group key={plane} position={pos} rotation={rot}>
                <mesh
                  onPointerDown={(e) => handleR3FPointerDown(descriptor, e)}
                  renderOrder={RENDER_POLICIES.selectionShell.renderOrder + 1}
                  userData={{ gizmo: "texture-translate-plane", plane, gizmoHandle: descriptor }}
                >
                  <planeGeometry args={[L * 0.2, L * 0.2]} />
                  <meshBasicMaterial
                    color={active ? highlightColor : color}
                    depthTest={false}
                    opacity={active ? 0.78 : 0.48}
                    side={DoubleSide}
                    toneMapped={false}
                    transparent
                  />
                </mesh>
                <mesh
                  onPointerDown={(e) => handleR3FPointerDown(descriptor, e)}
                  renderOrder={RENDER_POLICIES.selectionShell.renderOrder + 3}
                  userData={{ gizmo: "texture-translate-plane-hitbox", plane, gizmoHandle: descriptor }}
                >
                  <planeGeometry args={[L * 0.3, L * 0.3]} />
                  <meshBasicMaterial
                    depthTest={false}
                    depthWrite={false}
                    opacity={0}
                    side={DoubleSide}
                    transparent
                  />
                </mesh>
              </group>
            );
          })}
        </group>
      ) : null}

      {gizmoMode === "rotate" ? (
        <group userData={{ gizmoMode: "rotate" }}>
          {(
            [
              { axis: "x" as const, rot: [0, Math.PI / 2, 0] as Vec3, color: xColor },
              { axis: "y" as const, rot: [Math.PI / 2, 0, 0] as Vec3, color: yColor },
              { axis: "z" as const, rot: [0, 0, 0] as Vec3, color: zColor },
            ] as const
          ).map(({ axis, rot, color }) => {
            const key = `rotate:${axis}`;
            const descriptor: GizmoHandleDescriptor = {
              mode: "rotate",
              handle: axis,
              key,
              priority: 1,
            };
            const active = isHighlighted(key);
            return (
              <group key={axis} rotation={rot}>
                <mesh
                  onPointerDown={(e) => handleR3FPointerDown(descriptor, e)}
                  renderOrder={RENDER_POLICIES.selectionShell.renderOrder + 1}
                  userData={{ axis, gizmo: "texture-rotate-ring", gizmoHandle: descriptor }}
                >
                  <torusGeometry
                    args={[L * 0.82, shaftRadius * (active ? 1.25 : 0.95), 14, 64]}
                  />
                  <meshBasicMaterial
                    color={active ? highlightColor : color}
                    depthTest={false}
                    toneMapped={false}
                  />
                </mesh>
                <mesh
                  onPointerDown={(e) => handleR3FPointerDown(descriptor, e)}
                  renderOrder={RENDER_POLICIES.selectionShell.renderOrder + 3}
                  userData={{ axis, gizmo: "texture-rotate-hitbox", gizmoHandle: descriptor }}
                >
                  <torusGeometry args={[L * 0.82, hitboxRadius, 12, 48]} />
                  <meshBasicMaterial depthTest={false} depthWrite={false} opacity={0} transparent />
                </mesh>
              </group>
            );
          })}
        </group>
      ) : null}

      {gizmoMode === "scale" ? (
        <group userData={{ gizmoMode: "scale" }}>
          {(() => {
            const uniformDescriptor: GizmoHandleDescriptor = {
              mode: "scale",
              handle: "uniform",
              key: "scale:uniform",
              priority: 2,
            };
            const uniformActive = isHighlighted("scale:uniform");
            const uniformVisual = tipSize * (uniformActive ? 1.45 : 1.28);
            const uniformHit = Math.max(tipSize * 2.4, hitboxRadius * 2);
            return (
              <group>
                <mesh
                  onPointerDown={(e) => handleR3FPointerDown(uniformDescriptor, e)}
                  renderOrder={RENDER_POLICIES.selectionShell.renderOrder + 2}
                  userData={{ gizmo: "texture-scale-uniform", gizmoHandle: uniformDescriptor }}
                >
                  <boxGeometry args={[uniformVisual, uniformVisual, uniformVisual]} />
                  <meshBasicMaterial
                    color={uniformActive ? highlightColor : colors.accent}
                    depthTest={false}
                    toneMapped={false}
                  />
                </mesh>
                <mesh
                  onPointerDown={(e) => handleR3FPointerDown(uniformDescriptor, e)}
                  renderOrder={RENDER_POLICIES.selectionShell.renderOrder + 3}
                  userData={{
                    gizmo: "texture-scale-uniform-hitbox",
                    gizmoHandle: uniformDescriptor,
                  }}
                >
                  <boxGeometry args={[uniformHit, uniformHit, uniformHit]} />
                  <meshBasicMaterial depthTest={false} depthWrite={false} opacity={0} transparent />
                </mesh>
              </group>
            );
          })()}
          {(
            [
              {
                axis: "x" as const,
                stalkPos: [L * 0.5, 0, 0] as Vec3,
                stalkHitPos: [L * 0.62, 0, 0] as Vec3,
                cubePos: [L, 0, 0] as Vec3,
                rot: [0, 0, -Math.PI / 2] as Vec3,
                color: xColor,
              },
              {
                axis: "y" as const,
                stalkPos: [0, L * 0.5, 0] as Vec3,
                stalkHitPos: [0, L * 0.62, 0] as Vec3,
                cubePos: [0, L, 0] as Vec3,
                rot: [0, 0, 0] as Vec3,
                color: yColor,
              },
              {
                axis: "z" as const,
                stalkPos: [0, 0, L * 0.5] as Vec3,
                stalkHitPos: [0, 0, L * 0.62] as Vec3,
                cubePos: [0, 0, L] as Vec3,
                rot: [Math.PI / 2, 0, 0] as Vec3,
                color: zColor,
              },
            ] as const
          ).map(({ axis, stalkPos, stalkHitPos, cubePos, rot, color }) => {
            const key = `scale:${axis}`;
            const descriptor: GizmoHandleDescriptor = {
              mode: "scale",
              handle: axis,
              key,
              priority: 1,
            };
            const active = isHighlighted(key);
            const activeColor = active ? highlightColor : color;
            const cubeSize = tipSize * (active ? 1.32 : 1.15);
            const cubeHitSize = Math.max(tipSize * 3.2, hitboxRadius * 2.2);
            return (
              <group key={axis}>
                <mesh
                  onPointerDown={(e) => handleR3FPointerDown(descriptor, e)}
                  position={stalkPos}
                  renderOrder={RENDER_POLICIES.selectionShell.renderOrder + 1}
                  rotation={rot}
                  userData={{ axis, gizmo: "texture-scale-stalk", gizmoHandle: descriptor }}
                >
                  <cylinderGeometry
                    args={[shaftRadius * (active ? 1.2 : 0.9), shaftRadius * (active ? 1.2 : 0.9), L, 12]}
                  />
                  <meshBasicMaterial color={activeColor} depthTest={false} toneMapped={false} />
                </mesh>
                <mesh
                  onPointerDown={(e) => handleR3FPointerDown(descriptor, e)}
                  position={cubePos}
                  renderOrder={RENDER_POLICIES.selectionShell.renderOrder + 2}
                  userData={{ axis, gizmo: "texture-scale-axis", gizmoHandle: descriptor }}
                >
                  <boxGeometry args={[cubeSize, cubeSize, cubeSize]} />
                  <meshBasicMaterial color={activeColor} depthTest={false} toneMapped={false} />
                </mesh>
                <mesh
                  onPointerDown={(e) => handleR3FPointerDown(descriptor, e)}
                  position={stalkHitPos}
                  renderOrder={RENDER_POLICIES.selectionShell.renderOrder + 3}
                  rotation={rot}
                  userData={{ axis, gizmo: "texture-scale-stalk-hitbox", gizmoHandle: descriptor }}
                >
                  <cylinderGeometry args={[hitboxRadius, hitboxRadius, L * 0.76, 12]} />
                  <meshBasicMaterial depthTest={false} depthWrite={false} opacity={0} transparent />
                </mesh>
                <mesh
                  onPointerDown={(e) => handleR3FPointerDown(descriptor, e)}
                  position={cubePos}
                  renderOrder={RENDER_POLICIES.selectionShell.renderOrder + 3}
                  userData={{ axis, gizmo: "texture-scale-cube-hitbox", gizmoHandle: descriptor }}
                >
                  <boxGeometry args={[cubeHitSize, cubeHitSize, cubeHitSize]} />
                  <meshBasicMaterial depthTest={false} depthWrite={false} opacity={0} transparent />
                </mesh>
              </group>
            );
          })}
        </group>
      ) : null}
    </group>
  );
}

/**
 * Returns a primitive selector key describing which object currently has an
 * active live Magnetic Texture draft/gizmo surface, without changing reference
 * on every 60 FPS drag frame.
 */
export function getActiveLiveTextureSurfaceKey(): string | null {
  const snapshot = getTextureDraftBridgeSnapshot();
  if (
    snapshot.activeBinding &&
    snapshot.activeBinding.draft.sourceMode !== "field-file"
  ) {
    return snapshot.activeBinding.target.objectId;
  }
  return snapshot.gizmoEnabled ? "__selected__" : null;
}

/**
 * Shared predicate deciding whether a primitive object renders a persistent
 * authored magnetization HSL surface (outside live solver coverage and saved playback).
 */
export function isPersistentAuthoredTextureSurfaceEligible(
  object: Viewport3DPrimitiveObject,
  options: {
    readonly activeBindingObjectId: string | null;
    readonly getObjectSettings?: (object: Viewport3DPrimitiveObject) => VisualizationTargetSettings;
    readonly liveFieldCoveredObjectIds?: ReadonlySet<string>;
    readonly savedViewportActive?: boolean;
    readonly textureTransformModel: Viewport3DTextureTransformModel;
  },
): boolean {
  if (options.savedViewportActive || !options.getObjectSettings) return false;
  if (object.objectId === options.activeBindingObjectId) return false;
  if (!options.textureTransformModel.hasAuthoredMagnetization(object.objectId)) return false;
  if (options.liveFieldCoveredObjectIds?.has(object.objectId)) return false;
  const s = options.getObjectSettings(object);
  // Before a solver/mesh field exists, resolveViewport3DPrimitiveVisualizationSettings
  // turns shaderVisible off and sets primitiveVisible = true so shaded geometry stays visible.
  // Honor BOTH flags so the authored magnetization surface renders on shaded primitives
  // while still hiding cleanly in Wireframe/Off modes or when Solid color is chosen.
  const surfaceVisible = s.shaderVisible || Boolean(s.primitiveVisible);
  if (!s.visible || !surfaceVisible || s.surfaceColorSource === "solid") return false;
  // Hide authored m overlay when the user has selected a different quantity.
  if (s.activeQuantityId && resolveCanonicalQuantityId(s.activeQuantityId) !== "m") return false;
  return true;
}

/**
 * Computes the set of objectIds whose surface is currently rendered by
 * `Viewport3DTextureTransformLayer` (either live draft or persistent authored texture),
 * allowing `PrimitiveObjectLayer` and `Array3DInstancedPreviewLayer` to suppress
 * their coplanar base solid fill and prevent z-fighting.
 */
export function resolveActiveAuthoredTextureSurfaceObjectIds({
  activeLiveSurfaceKey,
  getObjectSettings,
  liveFieldCoveredObjectIds,
  primitiveModel,
  savedViewportActive = false,
  selectedObjectId,
  textureTransformModel,
}: {
  readonly activeLiveSurfaceKey: string | null;
  readonly getObjectSettings?: (object: Viewport3DPrimitiveObject) => VisualizationTargetSettings;
  readonly liveFieldCoveredObjectIds?: ReadonlySet<string>;
  readonly primitiveModel: Viewport3DPrimitiveRenderModel | null;
  readonly savedViewportActive?: boolean;
  readonly selectedObjectId: string | null;
  readonly textureTransformModel: Viewport3DTextureTransformModel;
}): ReadonlySet<string> {
  const covered = new Set<string>();
  if (!primitiveModel?.objects.length) return covered;

  const activeBindingObjectId =
    activeLiveSurfaceKey && activeLiveSurfaceKey !== "__selected__"
      ? activeLiveSurfaceKey
      : null;

  if (activeBindingObjectId) {
    const targetId = selectedObjectId ?? activeBindingObjectId;
    if (
      targetId === activeBindingObjectId &&
      primitiveModel.objects.some((obj) => obj.objectId === activeBindingObjectId)
    ) {
      covered.add(activeBindingObjectId);
    }
  } else if (activeLiveSurfaceKey === "__selected__" && selectedObjectId) {
    const selectedObj = primitiveModel.objects.find((obj) => obj.objectId === selectedObjectId);
    if (selectedObj) {
      const authored = textureTransformModel.getAuthoredDraft(selectedObj.objectId);
      if (authored && authored.draft.sourceMode !== "field-file") {
        covered.add(selectedObj.objectId);
      }
    }
  }

  for (const obj of primitiveModel.objects) {
    if (
      isPersistentAuthoredTextureSurfaceEligible(obj, {
        activeBindingObjectId,
        getObjectSettings,
        liveFieldCoveredObjectIds,
        savedViewportActive,
        textureTransformModel,
      })
    ) {
      covered.add(obj.objectId);
    }
  }

  return covered;
}

function forwardTextureSurfacePick(
  object: Viewport3DPrimitiveObject,
  onSelectObject:
    | ((object: Viewport3DPrimitiveObject, modifiers?: Viewport3DPickModifiers) => void)
    | undefined,
  event: ThreeEvent<PointerEvent>,
): void {
  if (!onSelectObject) return;
  if (eventIntersectsRegionOverlay(event)) return;
  event.stopPropagation();
  const native = event.nativeEvent;
  onSelectObject(object, {
    ctrlKey: Boolean(native?.ctrlKey ?? event.ctrlKey),
    metaKey: Boolean(native?.metaKey ?? event.metaKey),
    shiftKey: Boolean(native?.shiftKey ?? event.shiftKey),
  });
}

export function Viewport3DTextureTransformLayer({
  onGestureActiveChange,
  onSelectObject,
  primitiveModel,
  selectedObjectId,
  textureTransformModel,
  tracker,
  savedViewportActive = false,
  getObjectSettings,
  liveFieldCoveredObjectIds,
}: {
  onGestureActiveChange?: (active: boolean) => void;
  onSelectObject?: (
    object: Viewport3DPrimitiveObject,
    modifiers?: Viewport3DPickModifiers,
  ) => void;
  primitiveModel: Viewport3DPrimitiveRenderModel | null;
  selectedObjectId: string | null;
  textureTransformModel: Viewport3DTextureTransformModel;
  tracker?: Viewport3DResourceTracker;
  /** When true, a saved results playback is active — do not render authored texture overlays. */
  savedViewportActive?: boolean;
  /**
   * Returns visualization settings for a primitive object. Used to gate authored
   * texture overlay rendering: hides the overlay when the object is invisible,
   * in wireframe mode, or uses solid color source.
   */
  getObjectSettings?: (object: Viewport3DPrimitiveObject) => VisualizationTargetSettings;
  /**
   * Set of objectIds that currently have an active live discretized solver field
   * rendering (FDM or FEM). When an object is in this set, the static authored
   * magnetization overlay is suppressed so it does not paint on top of live results.
   */
  liveFieldCoveredObjectIds?: ReadonlySet<string>;
}) {
  const bridge = useSyncExternalStore(
    subscribeTextureDraftBridge,
    getTextureDraftBridgeSnapshot,
    getTextureDraftBridgeSnapshot,
  );
  const { colors } = useViewport3DColors();
  const invalidate = useBatchedInvalidate();

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    return installTextureGizmoKeyboardShortcuts(window);
  }, []);

  const targetObjectId = selectedObjectId ?? bridge.activeBinding?.target.objectId ?? null;

  const selectedObject = useMemo(() => {
    if (!targetObjectId || !primitiveModel?.objects.length) return null;
    return (
      primitiveModel.objects.find((candidate) => candidate.objectId === targetObjectId) ??
      null
    );
  }, [primitiveModel, targetObjectId]);

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
    if (!bridge.gizmoEnabled) return null;
    return textureTransformModel.getAuthoredDraft(selectedObject.objectId);
  }, [bindingMatchesObject, bridge.activeBinding, bridge.gizmoEnabled, selectedObject, textureTransformModel]);

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
    try {
      return textureTransformModel.sampleSurfaceColors({
        objectId: selectedObject.objectId,
        positionsWorld: subdividedMeshData.positionsWorld,
        liveBinding: bindingMatchesObject ? bridge.activeBinding : null,
      });
    } catch {
      return null;
    }
  }, [
    bindingMatchesObject,
    bridge.activeBinding,
    selectedObject,
    showSurfacePreview,
    subdividedMeshData,
    textureTransformModel,
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

  const handlesActive = Boolean(
    selectedObject &&
      isTextureGizmoHandleModeActive(bridge, selectedObject.objectId),
  );

  const proxySegments = useMemo(() => {
    if (!bridge.gizmoEnabled || !bindingMatchesObject || !effectiveDraftAndBounds) return null;
    return buildCharacteristicProxyWireframeSegments(
      effectiveDraftAndBounds.draft,
      effectiveDraftAndBounds.bounds,
    );
  }, [bindingMatchesObject, bridge.gizmoEnabled, effectiveDraftAndBounds]);

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

  // Persistent authored texture overlays for objects not covered by the live draft.
  // Computed before the gizmo early-return so they render even when no active binding.
  const activeBindingObjectId = bridge.activeBinding?.target.objectId ?? null;
  const persistentOverlayObjects =
    !savedViewportActive && getObjectSettings && primitiveModel
      ? primitiveModel.objects.filter((obj) =>
          isPersistentAuthoredTextureSurfaceEligible(obj, {
            activeBindingObjectId,
            getObjectSettings,
            liveFieldCoveredObjectIds,
            savedViewportActive,
            textureTransformModel,
          }),
        )
      : [];

  // Persistent authored magnetization 3D vector arrows for objects not covered by live solver fields.
  const persistentVectorObjects =
    !savedViewportActive && getObjectSettings && primitiveModel
      ? primitiveModel.objects.filter((obj) => {
          const isLiveBound =
            obj.objectId === activeBindingObjectId &&
            bridge.activeBinding?.draft.sourceMode !== "field-file";
          if (!isLiveBound && !textureTransformModel.hasAuthoredMagnetization(obj.objectId)) {
            return false;
          }
          if (liveFieldCoveredObjectIds?.has(obj.objectId)) return false;
          const s = getObjectSettings(obj);
          if (!s.visible || !s.vectorsVisible) return false;
          if (s.activeQuantityId && resolveCanonicalQuantityId(s.activeQuantityId) !== "m") {
            return false;
          }
          return true;
        })
      : [];

  const fallbackVectorMonoColor = colors?.accent ?? colors?.field;

  if (!colors || !selectedObject || !effectiveDraftAndBounds) {
    if (persistentOverlayObjects.length === 0 && persistentVectorObjects.length === 0) return null;
    return (
      <>
        {persistentOverlayObjects.map((obj) => {
          const opacity = getObjectSettings
            ? Math.max(0, Math.min(1, (getObjectSettings(obj).surfaceOpacityPercent ?? 100) / 100))
            : 1;
          return (
            <AuthoredMagnetizationPersistentSurface
              key={obj.objectId}
              object={obj}
              onSelectObject={onSelectObject}
              opacity={opacity}
              textureTransformModel={textureTransformModel}
              tracker={tracker}
            />
          );
        })}
        {getObjectSettings
          ? persistentVectorObjects.map((obj) => (
              <AuthoredMagnetizationPersistentVectors
                key={`vectors:${obj.objectId}`}
                fallbackMonoColor={fallbackVectorMonoColor}
                liveBinding={obj.objectId === activeBindingObjectId ? bridge.activeBinding : null}
                object={obj}
                settings={getObjectSettings(obj)}
                textureTransformModel={textureTransformModel}
                tracker={tracker}
              />
            ))
          : null}
      </>
    );
  }

  const { draft, bounds } = effectiveDraftAndBounds;
  const pose = resolveTextureGizmoWorldPose(draft, bounds);
  const liveSurfaceOpacity = getObjectSettings
    ? Math.max(0, Math.min(1, (getObjectSettings(selectedObject).surfaceOpacityPercent ?? 100) / 100))
    : 0.92;
  const liveSurfaceTransparent = liveSurfaceOpacity < 0.99;

  return (
    <>
      {persistentOverlayObjects.map((obj) => {
        const opacity = getObjectSettings
          ? Math.max(0, Math.min(1, (getObjectSettings(obj).surfaceOpacityPercent ?? 100) / 100))
          : 1;
        return (
          <AuthoredMagnetizationPersistentSurface
            key={obj.objectId}
            object={obj}
            onSelectObject={onSelectObject}
            opacity={opacity}
            textureTransformModel={textureTransformModel}
            tracker={tracker}
          />
        );
      })}
      {getObjectSettings
        ? persistentVectorObjects.map((obj) => (
            <AuthoredMagnetizationPersistentVectors
              key={`vectors:${obj.objectId}`}
              fallbackMonoColor={fallbackVectorMonoColor}
              liveBinding={obj.objectId === activeBindingObjectId ? bridge.activeBinding : null}
              object={obj}
              settings={getObjectSettings(obj)}
              textureTransformModel={textureTransformModel}
              tracker={tracker}
            />
          ))
        : null}
      <group
        name={`texture-transform-layer:${selectedObject.objectId}`}
        userData={{ gizmo: "texture-transform-layer", objectId: selectedObject.objectId }}
      >
        {surfaceGeometry ? (
          <mesh
            geometry={surfaceGeometry}
            onPointerDown={(event) =>
              forwardTextureSurfacePick(selectedObject, onSelectObject, event)
            }
            renderOrder={
              liveSurfaceTransparent
                ? RENDER_POLICIES.contextSurface.renderOrder
                : RENDER_POLICIES.solidSurface.renderOrder
            }
            userData={{
              gizmo: "texture-surface-preview",
              objectId: selectedObject.objectId,
            }}
          >
            <meshBasicMaterial
              depthWrite={!liveSurfaceTransparent}
              opacity={liveSurfaceOpacity}
              polygonOffset
              polygonOffsetFactor={-1}
              polygonOffsetUnits={-1}
              toneMapped={false}
              transparent={liveSurfaceTransparent}
              vertexColors
            />
          </mesh>
        ) : null}

        {handlesActive && bridge.gizmoMode !== "view" ? (
          <TextureGizmoInteractiveHandles
            colors={colors}
            draft={draft}
            gizmoMode={bridge.gizmoMode}
            invalidate={invalidate}
            objectId={selectedObject.objectId}
            onGestureActiveChange={onGestureActiveChange}
            pose={pose}
            proxyGeometry={proxyGeometry}
          />
        ) : bridge.gizmoEnabled && bindingMatchesObject && proxyGeometry ? (
          <group
            name={`texture-gizmo-preview:${selectedObject.objectId}`}
            position={pose.originWorld}
            userData={{
              gizmo: "texture-transform-preview",
              mode: "view",
              objectId: selectedObject.objectId,
            }}
          >
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
          </group>
        ) : null}
      </group>
    </>
  );
}

/**
 * Renders the authored magnetization HSL surface for a single primitive object
 * when it is not covered by an active live draft or a saved results playback.
 * Uses its own hook set so it can be rendered per-object in a React.Fragment.
 */
function AuthoredMagnetizationPersistentSurface({
  object,
  onSelectObject,
  opacity = 1,
  textureTransformModel,
  tracker,
}: {
  object: Viewport3DPrimitiveObject;
  onSelectObject?: (
    object: Viewport3DPrimitiveObject,
    modifiers?: Viewport3DPickModifiers,
  ) => void;
  opacity?: number;
  textureTransformModel: Viewport3DTextureTransformModel;
  tracker?: Viewport3DResourceTracker;
}) {
  const invalidate = useBatchedInvalidate();

  const draftAndBounds = useMemo(
    () => textureTransformModel.getAuthoredDraft(object.objectId),
    [object.objectId, textureTransformModel],
  );

  const subdividedMeshData = useMemo(() => {
    if (!draftAndBounds) return null;
    return buildSubdividedSurfacePreviewData(object, SURFACE_PREVIEW_GRID_RES);
  }, [draftAndBounds, object]);

  const surfaceColors = useMemo(() => {
    if (!draftAndBounds || !subdividedMeshData) return null;
    try {
      return textureTransformModel.sampleSurfaceColors({
        objectId: object.objectId,
        positionsWorld: subdividedMeshData.positionsWorld,
        liveBinding: null,
      });
    } catch {
      return null;
    }
  }, [draftAndBounds, object.objectId, subdividedMeshData, textureTransformModel]);

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

  if (!surfaceGeometry) return null;
  const isTransparent = opacity < 0.99;

  return (
    <mesh
      geometry={surfaceGeometry}
      onPointerDown={(event) =>
        forwardTextureSurfacePick(object, onSelectObject, event)
      }
      renderOrder={
        isTransparent
          ? RENDER_POLICIES.contextSurface.renderOrder
          : RENDER_POLICIES.solidSurface.renderOrder
      }
      userData={{
        gizmo: "texture-surface-preview",
        objectId: object.objectId,
      }}
    >
      <meshBasicMaterial
        depthWrite={!isTransparent}
        opacity={opacity}
        polygonOffset
        polygonOffsetFactor={-1}
        polygonOffsetUnits={-1}
        toneMapped={false}
        transparent={isTransparent}
        vertexColors
      />
    </mesh>
  );
}

function syncAuthoredVectorMaterial(
  material: MeshBasicMaterial,
  options: {
    readonly opacity: number;
    readonly transparent: boolean;
    readonly depthTest: boolean;
    readonly depthWrite: boolean;
  },
): void {
  material.opacity = options.opacity;
  material.transparent = options.transparent;
  material.depthTest = options.depthTest;
  material.depthWrite = options.depthWrite;
  material.toneMapped = false;
  material.vertexColors = true;
  material.color.set("white");
  material.needsUpdate = true;
}

function uploadAuthoredVectorGlyphInstances(options: {
  readonly shaft: InstancedMesh;
  readonly head: InstancedMesh;
  readonly instanceColorAttr: InstancedBufferAttribute;
  readonly glyphData: AuthoredMagnetizationArrowGlyphData;
  readonly capacity: number;
  readonly scratch: {
    readonly direction: Vector3;
    readonly matrix: Matrix4;
    readonly position: Vector3;
    readonly quaternion: Quaternion;
    readonly scale: Vector3;
  };
}): void {
  const { shaft, head, instanceColorAttr, glyphData, capacity, scratch } = options;
  const count = Math.min(glyphData.arrowCount, capacity);
  const { transforms, colors } = glyphData;
  const { direction, matrix, position, quaternion, scale } = scratch;

  shaft.instanceMatrix.setUsage(DynamicDrawUsage);
  head.instanceMatrix.setUsage(DynamicDrawUsage);

  (instanceColorAttr.array as Float32Array).set(colors.subarray(0, count * 3), 0);
  instanceColorAttr.needsUpdate = true;

  for (let i = 0; i < count; i += 1) {
    const offset = i * 3;
    direction.set(
      transforms.directions[offset] ?? 0,
      transforms.directions[offset + 1] ?? 1,
      transforms.directions[offset + 2] ?? 0,
    );
    quaternion.setFromUnitVectors(AUTHORED_VECTOR_UNIT_Y, direction);

    position.set(
      transforms.shaftCenters[offset] ?? 0,
      transforms.shaftCenters[offset + 1] ?? 0,
      transforms.shaftCenters[offset + 2] ?? 0,
    );
    scale.set(
      transforms.shaftScales[offset] ?? 0,
      transforms.shaftScales[offset + 1] ?? 0,
      transforms.shaftScales[offset + 2] ?? 0,
    );
    matrix.compose(position, quaternion, scale);
    shaft.setMatrixAt(i, matrix);

    position.set(
      transforms.headCenters[offset] ?? 0,
      transforms.headCenters[offset + 1] ?? 0,
      transforms.headCenters[offset + 2] ?? 0,
    );
    scale.set(
      transforms.headScales[offset] ?? 0,
      transforms.headScales[offset + 1] ?? 0,
      transforms.headScales[offset + 2] ?? 0,
    );
    matrix.compose(position, quaternion, scale);
    head.setMatrixAt(i, matrix);
  }

  shaft.count = count;
  head.count = count;
  shaft.instanceColor = instanceColorAttr;
  head.instanceColor = instanceColorAttr;
  shaft.instanceMatrix.needsUpdate = true;
  head.instanceMatrix.needsUpdate = true;
}

/**
 * Renders 3D solid instanced magnetization vector arrows (cylinder shafts +
 * cone arrowheads via `InstancedMesh`) for a primitive object with a committed
 * authored magnetic texture when no discretized solver field buffer covers it yet.
 */
function AuthoredMagnetizationPersistentVectors({
  fallbackMonoColor,
  liveBinding = null,
  object,
  settings,
  textureTransformModel,
  tracker,
}: {
  fallbackMonoColor?: ColorRepresentation;
  liveBinding?: TextureInspectorDraftBinding | null;
  object: Viewport3DPrimitiveObject;
  settings: VisualizationTargetSettings;
  textureTransformModel: Viewport3DTextureTransformModel;
  tracker?: Viewport3DResourceTracker;
}) {
  const invalidate = useBatchedInvalidate();
  const shaftRef = useRef<InstancedMesh>(null);
  const headRef = useRef<InstancedMesh>(null);
  const glyphPolicy = RENDER_POLICIES.glyphs;

  const grid = useMemo(
    () =>
      buildAuthoredMagnetizationVectorGridPoints(object, {
        budget: settings.vectorBudget,
        geometryScope: settings.geometryScope,
        surfaceOffsetEnabled: settings.vectorSurfaceOffsetEnabled,
        surfaceOffsetScale: settings.vectorSurfaceOffsetScale,
      }),
    [
      object,
      settings.geometryScope,
      settings.vectorBudget,
      settings.vectorSurfaceOffsetEnabled,
      settings.vectorSurfaceOffsetScale,
    ],
  );

  const sampledVectors = useMemo(() => {
    if (grid.count <= 0) return null;
    try {
      return (
        textureTransformModel.sampleVectors?.({
          objectId: object.objectId,
          positionsWorld: grid.positionsWorld,
          liveBinding,
        }) ?? null
      );
    } catch {
      return null;
    }
  }, [grid.count, grid.positionsWorld, liveBinding, object.objectId, textureTransformModel]);

  const glyphData = useMemo(() => {
    if (!sampledVectors || grid.count <= 0) return null;
    return buildAuthoredMagnetizationArrowGlyphData(
      grid.positionsWorld,
      sampledVectors,
      grid.pitch,
      {
        centeringEnabled: settings.vectorCenteringEnabled,
        colorMode: settings.vectorColorMode,
        fallbackMonoColor,
        lengthScale: settings.vectorLengthScale,
        monoColor: settings.vectorMonoColor,
        scalarColorPalette: settings.scalarColorPalette,
        thickness: settings.vectorThickness,
      },
    );
  }, [
    fallbackMonoColor,
    grid.count,
    grid.pitch,
    grid.positionsWorld,
    sampledVectors,
    settings.scalarColorPalette,
    settings.vectorCenteringEnabled,
    settings.vectorColorMode,
    settings.vectorLengthScale,
    settings.vectorMonoColor,
    settings.vectorThickness,
  ]);

  const glyphCount = glyphData?.arrowCount ?? 0;
  const opacity = Math.max(0, Math.min(1, (settings.vectorAlphaPercent ?? 100) / 100));
  const isRendered = Boolean(glyphData && glyphCount > 0 && opacity > 0);
  const capacity = useMemo(() => resolveAuthoredVectorCapacity(glyphCount), [glyphCount]);
  const depthPolicy = resolveVectorGlyphDepthPolicy(grid.renderOnTop);

  const transformScratch = useMemo(
    () => ({
      direction: new Vector3(),
      matrix: new Matrix4(),
      position: new Vector3(),
      quaternion: new Quaternion(),
      scale: new Vector3(),
    }),
    [],
  );

  const shaftGeometry = useMemo(() => {
    const geom = ensureWhiteVertexColorAttribute(new CylinderGeometry(1, 1, 1, 8));
    return tracker ? tracker.track("geometry", geom) : geom;
  }, [tracker]);

  const headGeometry = useMemo(() => {
    const geom = ensureWhiteVertexColorAttribute(new ConeGeometry(1, 1, 10));
    return tracker ? tracker.track("geometry", geom) : geom;
  }, [tracker]);

  const material = useMemo(() => {
    const mat = new MeshBasicMaterial({
      color: "white",
      depthTest: glyphPolicy.depthTest,
      depthWrite: glyphPolicy.depthWrite,
      side: glyphPolicy.side,
      toneMapped: false,
      vertexColors: true,
    });
    return tracker ? tracker.track("material", mat) : mat;
  }, [glyphPolicy.depthTest, glyphPolicy.depthWrite, glyphPolicy.side, tracker]);

  const instanceColorAttr = useMemo(() => {
    const attr = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    attr.setUsage(DynamicDrawUsage);
    return attr;
  }, [capacity]);

  useEffect(
    () => () => {
      if (tracker) {
        tracker.release("geometry", shaftGeometry);
      } else {
        shaftGeometry.dispose();
      }
    },
    [shaftGeometry, tracker],
  );

  useEffect(
    () => () => {
      if (tracker) {
        tracker.release("geometry", headGeometry);
      } else {
        headGeometry.dispose();
      }
    },
    [headGeometry, tracker],
  );

  useEffect(
    () => () => {
      if (tracker) {
        tracker.release("material", material);
      } else {
        material.dispose();
      }
    },
    [material, tracker],
  );

  useEffect(
    () => () => {
      instanceColorAttr.dispose();
    },
    [instanceColorAttr],
  );

  useEffect(() => {
    const shaft = shaftRef.current;
    const head = headRef.current;
    return () => {
      if (shaft) {
        shaft.instanceColor = null;
        shaft.instanceMatrix.dispose();
      }
      if (head) {
        head.instanceColor = null;
        head.instanceMatrix.dispose();
      }
    };
  }, [capacity, isRendered]);

  useEffect(() => {
    syncAuthoredVectorMaterial(material, {
      opacity,
      transparent: glyphPolicy.transparent || opacity < 0.99,
      depthTest: depthPolicy.depthTest,
      depthWrite: depthPolicy.depthWrite,
    });
    tracker?.recordDirtyFrame("vector-glyph-material");
    invalidate();
  }, [
    depthPolicy.depthTest,
    depthPolicy.depthWrite,
    glyphPolicy.transparent,
    invalidate,
    material,
    opacity,
    tracker,
  ]);

  useEffect(() => {
    const shaft = shaftRef.current;
    const head = headRef.current;
    if (!isRendered || !glyphData || !shaft || !head) return;

    uploadAuthoredVectorGlyphInstances({
      shaft,
      head,
      instanceColorAttr,
      glyphData,
      capacity,
      scratch: transformScratch,
    });

    tracker?.recordDirtyFrame("vector-glyphs");
    invalidate();
  }, [
    capacity,
    glyphData,
    instanceColorAttr,
    invalidate,
    isRendered,
    tracker,
    transformScratch,
  ]);

  if (!isRendered) return null;

  return (
    <>
      <instancedMesh
        args={[shaftGeometry, material, capacity]}
        count={0}
        frustumCulled={false}
        key={`authored-vector-shaft-${capacity}`}
        material-depthTest={depthPolicy.depthTest}
        material-depthWrite={depthPolicy.depthWrite}
        ref={shaftRef}
        renderOrder={glyphPolicy.renderOrder}
        userData={{
          gizmo: "texture-authored-vectors",
          objectId: object.objectId,
        }}
      />
      <instancedMesh
        args={[headGeometry, material, capacity]}
        count={0}
        frustumCulled={false}
        key={`authored-vector-head-${capacity}`}
        material-depthTest={depthPolicy.depthTest}
        material-depthWrite={depthPolicy.depthWrite}
        ref={headRef}
        renderOrder={glyphPolicy.renderOrder}
        userData={{
          gizmo: "texture-authored-vectors",
          objectId: object.objectId,
        }}
      />
    </>
  );
}
