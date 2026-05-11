"use client";

import { useDeferredValue, useEffect, useRef, useState, useCallback, useMemo, memo, type Dispatch, type SetStateAction } from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import { TrackballControls } from "@react-three/drei";
import { cn } from "@/lib/utils";
import {
  incrementFrontendAuditCounter,
  recordFrontendAuditWebGLContext,
} from "@/lib/debug/frontendAudit";
import ViewCube from "@/components/preview/ViewCube";
import HslSphere from "@/components/preview/HslSphere";
import FdmInstances from "@/components/preview/r3f/FdmInstances";
import { rotateCameraAroundTarget, focusCameraOnBounds, fitCameraToBounds } from "@/components/preview/camera/cameraHelpers";
import {
  captureOrientationDebugSnapshot,
  type OrientationDebugSnapshot,
} from "@/components/preview/camera/cameraOrientation";
import FdmLighting from "@/components/preview/r3f/FdmLighting";
import SceneAxes3D from "@/components/preview/r3f/SceneAxes3D";
import { useCanvasHost } from "@/components/preview/shared/useCanvasHost";
import ViewportTelemetryProbe from "@/components/preview/shared/ViewportTelemetryProbe";
import { useViewportContextLossRecovery } from "@/components/preview/shared/useViewportContextLossRecovery";
import { useViewportSceneBridgeSync } from "@/components/preview/shared/useViewportSceneBridgeSync";
import { resolveViewportFrameloop } from "@/components/preview/shared/viewportFrameloopPolicy";
import TextureTransformGizmo, {
  type TextureGizmoMode,
  type TexturePreviewProxy,
} from "@/components/preview/TextureTransformGizmo";
import type { TextureTransform3D } from "@/lib/textureTransform";
import type { VisualizationPresetFdmState } from "@/lib/session/types";
import type { Viewport3DModel } from "@/features/viewport-unified/model/viewport3dContracts";
import type {
  AntennaOverlayConductor,
  AntennaOverlay,
  BuilderObjectOverlay,
  FocusObjectRequest,
  ObjectViewMode,
} from "@/components/runs/control-room/shared";
import {
  Box,
  Palette,
  Eye,
  ArrowUpRight,
  Video,
  Camera,
  Info,
  Mountain,
  Move,
  RotateCw,
  Maximize2,
  MousePointer2,
} from "lucide-react";
import type { ReactNode } from "react";
import { ViewportToolbar3D } from "@/components/preview/ViewportToolbar3D";
import { ViewportToolGroup, ViewportToolSeparator } from "@/components/preview/ViewportToolGroup";
import { ViewportIconAction } from "@/components/preview/ViewportIconAction";
import { ViewportPopoverPanel, ViewportPopoverRow, ViewportPopoverTrigger } from "@/components/preview/ViewportPopoverPanel";
import { ViewportOverlayLayout } from "@/components/preview/ViewportOverlayLayout";
import { ViewportStatusChip } from "@/components/preview/ViewportStatusChips";
import {
  CAMERA_CONTROL_PROFILES,
  type CameraControlProfileId,
  createCameraStepLockState,
  applyCameraStepLock,
} from "@/components/preview/camera/cameraProfiles";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { writeFrontendDiagnosticConsole } from "@/lib/debug/frontendConsoleDebug";
import { useViewportTelemetryEntry } from "@/lib/debug/viewportTelemetry";
import { TransformGizmoLayer } from "@/components/preview/transform/TransformGizmoLayer";
import { axisLabelsForConvention } from "@/components/preview/transform/axisConvention";
import { useSceneCameraChange } from "@/components/preview/camera/useSceneCameraChange";
import {
  isViewportCameraAlreadyAtPersistedState,
  shouldSkipViewportCameraRestoreForAppliedState,
  shouldSkipViewportCameraRestoreForRestoredState,
  useViewportCameraPersistenceController,
} from "@/features/viewport-unified/camera-lifecycle";
import {
  captureViewportCameraState,
  restoreViewportCameraState,
} from "@/components/preview/camera/persistedViewportCamera";
import {
  physicalPositionToScene,
  physicalScaleToScene,
  sceneDeltaToPhysical,
} from "@/features/viewport-core/coordinates/physicalToScene";
import {
  useVectorSurfaceViewportSettings,
  type VectorSurfaceViewportSettings as Settings,
  type QualityLevel,
  type VoxelColorMode,
  type VoxelSampling,
  type TopoComponent,
} from "@/components/preview/useFdmViewportSettings";
import { isViewport3DVectorFieldRenderable } from "@/features/viewport-unified/hooks/useViewport3DVectorFieldModel";
import {
  shouldRenderVectorSurfaceCanvas,
} from "@/components/preview/shared/viewportWebglCanvasPolicy";
import type { ViewportCameraState } from "@/features/workspace-graph";
import type {
  VectorLiveRenderDebugData,
} from "@/features/viewport-unified/model/vectorLiveRenderDebugData";

const VECTOR_SURFACE_AXIS_CONVENTION = "swapYZ" as const;
const VECTOR_SURFACE_DEBUG_LOGS =
  FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging &&
  FRONTEND_DIAGNOSTIC_FLAGS.interactions.trace &&
  process.env.NODE_ENV !== "production";

export { shouldRenderVectorSurfaceCanvas };

export function shouldShowVectorSurfaceOrientationReference(args: {
  viewportVisible: boolean;
  geometryMode: boolean;
  viewport3DModel: Viewport3DModel | null | undefined;
  orientationReferenceKillSwitch: boolean;
}): boolean {
  return Boolean(
    !args.geometryMode &&
      args.orientationReferenceKillSwitch &&
      args.viewport3DModel?.overlays.orientationReferenceVisible,
  );
}

function WarmRevealInvalidator({ visible }: { visible: boolean }) {
  const { camera, gl, invalidate, scene } = useThree();
  const previousVisibleRef = useRef(false);
  useEffect(() => {
    const wasVisible = previousVisibleRef.current;
    previousVisibleRef.current = visible;
    if (wasVisible || !visible) {
      return;
    }
    let frame = 0;
    let disposed = false;
    const kick = () => {
      if (disposed) {
        return;
      }
      invalidate();
      gl.render(scene, camera);
      frame += 1;
      if (frame < 6) {
        window.requestAnimationFrame(kick);
      }
    };
    kick();
    return () => {
      disposed = true;
    };
  }, [camera, gl, invalidate, scene, visible]);
  return null;
}

function formatCameraFitNumber(value: number): string {
  return Number.isFinite(value) ? value.toPrecision(12) : "invalid";
}

export function buildVectorSurfaceCameraFitSignature(args: {
  viewportVisible: boolean;
  sceneMode: ViewportSceneMode;
  hasRenderableContent: boolean;
  center: readonly [number, number, number];
  extent: readonly [number, number, number];
}): string | null {
  if (!args.viewportVisible || !args.hasRenderableContent) {
    return null;
  }
  if (!args.extent.every((value) => Number.isFinite(value) && value > 0)) {
    return null;
  }
  const center = args.center.map(formatCameraFitNumber).join(",");
  const extent = args.extent.map(formatCameraFitNumber).join(",");
  return `${args.sceneMode}:${center}:${extent}`;
}

export function shouldApplyVectorSurfaceCameraAutoFit(args: {
  nextFitSignature: string | null;
  previousFitSignature: string | null;
  persistedCameraAvailable: boolean;
  cameraInteractionActive: boolean;
}): boolean {
  return Boolean(
    args.nextFitSignature &&
      !args.persistedCameraAvailable &&
      !args.cameraInteractionActive &&
      args.nextFitSignature !== args.previousFitSignature,
  );
}

function logVectorSurfaceDebug(event: string, payload?: Record<string, unknown>): void {
  if (!VECTOR_SURFACE_DEBUG_LOGS) {
    return;
  }
  if (payload) {
    writeFrontendDiagnosticConsole("info", `[viewport3d:vector-surface] ${event}`, payload);
    return;
  }
  writeFrontendDiagnosticConsole("info", `[viewport3d:vector-surface] ${event}`);
}

// ─── Types ──────────────────────────────────────────────────────────
interface Props {
  grid: [number, number, number];
  vectors: Float32Array | Float64Array | null;
  vectorValueScale?: number;
  fieldLabel?: string;
  liveRenderDebugData?: VectorLiveRenderDebugData | null;
  geometryMode?: boolean;
  activeMask?: boolean[] | null;
  /** Physical extent [x, y, z] in metres — enables in-scene axis labels */
  worldExtent?: [number, number, number] | null;
  objectOverlays?: BuilderObjectOverlay[];
  selectedObjectId?: string | null;
  antennaOverlays?: AntennaOverlay[];
  selectedAntennaId?: string | null;
  onAntennaTranslate?: (id: string, dx: number, dy: number, dz: number) => void;
  universeCenter?: [number, number, number] | null;
  viewportAxesScope?: "universe" | "object";
  universeWireframeVisible?: boolean;
  focusObjectRequest?: FocusObjectRequest | null;
  objectViewMode?: ObjectViewMode;
  onRequestObjectSelect?: (id: string) => void;
  onGeometryTranslate?: (id: string, dx: number, dy: number, dz: number) => void;
  /** Active texture transform for the selected object (physical coords, metres) */
  activeTextureTransform?: TextureTransform3D | null;
  textureGizmoMode?: TextureGizmoMode;
  activeTexturePreviewProxy?: TexturePreviewProxy;
  onTextureTransformChange?: (next: TextureTransform3D) => void;
  onTextureTransformCommit?: (next: TextureTransform3D) => void;
  activeTransformScope?: "object" | "texture" | null;
  onTransformScopeChange?: (scope: "object" | "texture" | null) => void;
  settings?: VisualizationPresetFdmState;
  viewport3DModel?: Viewport3DModel | null;
  onSettingsChange?: Dispatch<SetStateAction<VisualizationPresetFdmState>>;
  toolbarMode?: "visible" | "hidden";
  viewportVisible?: boolean;
  viewportDocumentId?: string | null;
  persistedCameraState?: ViewportCameraState | null;
  onPersistCameraState?: (state: ViewportCameraState) => void;
  onCameraInteractionChange?: (active: boolean) => void;
  /** Optional extra R3F nodes rendered inside the scene (e.g. geometry builder layer). */
  authoringOverlay?: ReactNode;
}

export type {
  QualityLevel,
  RenderMode,
  VoxelColorMode,
  VoxelSampling,
  TopoComponent,
} from "@/components/preview/useFdmViewportSettings";

const DEFAULT_CAMERA_DIRECTION: [number, number, number] = [0, 1, 0];
const DEFAULT_CAMERA_UP: [number, number, number] = [0, 0, -1];
const VECTOR_SURFACE_CAMERA_STATE_CACHE = new Map<
  string,
  {
    position: [number, number, number];
    up: [number, number, number];
    target: [number, number, number];
  }
>();

type RotationPanelKey = "viewport" | "viewCube" | "hsl";
type ViewportSceneMode = "grid" | "world";

function formatVector(values: readonly number[], digits = 3): string {
  return values.map((value) => value.toFixed(digits)).join(", ");
}

function formatCssTransform(transform: string): string {
  return transform.length > 92 ? `${transform.slice(0, 92)}...` : transform;
}

function formatDebugScalar(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "-";
  }
  const abs = Math.abs(value);
  if (abs >= 1_000 || (abs > 0 && abs < 1e-3)) {
    return value.toExponential(3);
  }
  return value.toFixed(6);
}

function sampledVectorRowIndices(vectorCount: number, sampleCount = 8): number[] {
  if (vectorCount <= 0) {
    return [];
  }
  if (vectorCount <= sampleCount) {
    return Array.from({ length: vectorCount }, (_, index) => index);
  }
  const lastIndex = vectorCount - 1;
  const indices = new Set<number>([0, 1, 2, lastIndex]);
  const interiorSamples = Math.max(sampleCount - indices.size, 0);
  for (let sampleIndex = 1; sampleIndex <= interiorSamples; sampleIndex += 1) {
    const normalized = sampleIndex / (interiorSamples + 1);
    indices.add(Math.round(lastIndex * normalized));
  }
  return Array.from(indices).sort((lhs, rhs) => lhs - rhs);
}

function buildRenderedVectorSample(vectors: Float32Array | null): string[] {
  if (!vectors || vectors.length < 3) {
    return [];
  }
  const vectorCount = Math.floor(vectors.length / 3);
  const width = String(Math.max(vectorCount - 1, 0)).length;
  return sampledVectorRowIndices(vectorCount).map((rowIndex) => {
    const base = rowIndex * 3;
    return `${String(rowIndex).padStart(width, "0")} | [${formatDebugScalar(vectors[base])}, ${formatDebugScalar(vectors[base + 1])}, ${formatDebugScalar(vectors[base + 2])}]`;
  });
}

export function toVectorSurfaceRenderBuffer(
  vectors: Float32Array | Float64Array | null,
  scale = 1,
): Float32Array | null {
  if (!vectors) {
    return null;
  }
  if (vectors instanceof Float32Array && scale === 1) {
    return vectors;
  }
  const renderBuffer = new Float32Array(vectors.length);
  for (let index = 0; index < vectors.length; index += 1) {
    renderBuffer[index] = vectors[index] * scale;
  }
  incrementFrontendAuditCounter("typedArrayAllocations", 1);
  return renderBuffer;
}

function combineOverlayBounds(
  overlays: readonly BuilderObjectOverlay[],
): { min: [number, number, number]; max: [number, number, number] } | null {
  if (overlays.length === 0) {
    return null;
  }
  let min: [number, number, number] | null = null;
  let max: [number, number, number] | null = null;
  for (const overlay of overlays) {
    if (!min || !max) {
      min = [...overlay.boundsMin] as [number, number, number];
      max = [...overlay.boundsMax] as [number, number, number];
      continue;
    }
    min = min.map((value, axis) => Math.min(value, overlay.boundsMin[axis])) as [
      number,
      number,
      number,
    ];
    max = max.map((value, axis) => Math.max(value, overlay.boundsMax[axis])) as [
      number,
      number,
      number,
    ];
  }
  return min && max ? { min, max } : null;
}

function formatDebugTimestamp(timestamp: number | null | undefined): string {
  if (timestamp == null || !Number.isFinite(timestamp)) {
    return "-";
  }
  return new Date(timestamp).toLocaleTimeString("pl-PL", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function settingsFromViewport3DModel(
  base: Settings,
  model: Viewport3DModel | null | undefined,
): Settings {
  const fdm = model?.fdm;
  if (!fdm) {
    return base;
  }
  return {
    ...base,
    quality: fdm.quality,
    renderMode: fdm.renderMode,
    voxelColorMode: fdm.voxelColorMode,
    sampling: fdm.sampling,
    brightness: fdm.brightness,
    voxelOpacity: fdm.voxelOpacity,
    voxelGap: fdm.voxelGap,
    voxelThreshold: fdm.voxelThreshold,
    topoEnabled: fdm.topography.enabled,
    topoComponent: fdm.topography.component,
    topoMultiplier: fdm.topography.amplitude,
  };
}

function formatLegendMode(settings: Settings): string {
  if (settings.renderMode === "glyph") {
    return "Vector arrows";
  }
  if (settings.voxelColorMode === "orientation") {
    return "Voxel orientation";
  }
  return `Voxel m${settings.voxelColorMode.toUpperCase()}`;
}

function RotationDebugBlock({
  label,
  snapshot,
}: {
  label: string;
  snapshot: OrientationDebugSnapshot | null;
}) {
  return (
    <div className="rounded-md border border-border/35 bg-background/35 px-2 py-2">
      <div className="text-[0.58rem] font-bold uppercase tracking-[0.18em] text-foreground/90">
        {label}
      </div>
      {snapshot ? (
        <div className="mt-1 space-y-1 text-[0.6rem] leading-4 text-muted-foreground">
          <div>
            <span className="text-foreground/80">Quat</span>: {formatVector(snapshot.quaternion, 4)}
          </div>
          <div>
            <span className="text-foreground/80">Euler</span>: {formatVector(snapshot.eulerDeg, 1)}
          </div>
          <div>
            <span className="text-foreground/80">Up</span>: {formatVector(snapshot.up, 3)}
          </div>
          <div>
            <span className="text-foreground/80">Fwd</span>: {formatVector(snapshot.forward, 3)}
          </div>
          <div>
            <span className="text-foreground/80">Pos</span>: {formatVector(snapshot.position, 3)}
          </div>
          <div className="break-all">
            <span className="text-foreground/80">Sig</span>: {snapshot.signature}
          </div>
          <div className="break-all">
            <span className="text-foreground/80">CSS</span>: {formatCssTransform(snapshot.cssTransform)}
          </div>
        </div>
      ) : (
        <div className="mt-1 text-[0.6rem] text-muted-foreground">Brak danych.</div>
      )}
    </div>
  );
}

// ─── R3F camera ↔ ViewCube bridge ───────────────────────────────────

function SyncedControls({
  controlsRefObject,
  viewCubeBridgeRef,
  target,
  cameraEnabled = true,
  onInteractionChange,
}: {
  controlsRefObject: React.MutableRefObject<any>;
  viewCubeBridgeRef: React.MutableRefObject<any>;
  target: [number, number, number];
  cameraEnabled?: boolean;
  onInteractionChange?: (active: boolean) => void;
}) {
  const { camera } = useThree();
  const stepLockState = useRef(createCameraStepLockState());
  const controlProfile: CameraControlProfileId = "fdm";
  const profile = CAMERA_CONTROL_PROFILES[controlProfile];
  const handleChange = useCallback(() => {
    const controls = controlsRefObject.current;
    const snapped = applyCameraStepLock({
      camera,
      controls,
      profile,
      state: stepLockState.current,
    });
    if (snapped) {
      controls?.update();
    }
  }, [camera, controlsRefObject, profile]);
  const handleInteractionStart = useCallback(() => {
    onInteractionChange?.(true);
  }, [onInteractionChange]);
  const handleInteractionEnd = useCallback(() => {
    onInteractionChange?.(false);
  }, [onInteractionChange]);

  useViewportSceneBridgeSync({
    bridgeRef: viewCubeBridgeRef,
    controlsRef: controlsRefObject,
    camera,
    awaitControls: true,
  });

  return (
    <TrackballControls
      ref={controlsRefObject}
      rotateSpeed={profile.rotateSpeed}
      zoomSpeed={profile.zoomSpeed}
      panSpeed={profile.panSpeed}
      dynamicDampingFactor={profile.dampingFactor}
      target={target}
      onChange={handleChange}
      onStart={handleInteractionStart}
      onEnd={handleInteractionEnd}
      enabled={cameraEnabled}
    />
  );
}

// ─── R3F scene background ───────────────────────────────────────────

const BG_COLOR = 0x1e1e2e; // Catppuccin Mocha Base

function SceneConfig({ toneMapping }: { toneMapping: boolean }) {
  const { gl } = useThree();
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  useEffect(() => {
    rendererRef.current = gl;
  }, [gl]);
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) {
      return;
    }
    if (toneMapping) {
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      return;
    }
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1;
  }, [toneMapping]);
  return null;
}

function antennaOverlayColors(role: AntennaOverlay["conductors"][number]["role"], selected: boolean) {
  if (role === "ground") {
    return selected
      ? { fill: "#67e8f9", wire: "#a5f3fc" }
      : { fill: "#0ea5e9", wire: "#67e8f9" };
  }
  return selected
    ? { fill: "#fb923c", wire: "#fdba74" }
    : { fill: "#f97316", wire: "#fb923c" };
}

function objectOverlayColors(selected: boolean, dimmed: boolean) {
  if (selected) {
    return { fill: "#facc15", wire: "#fff7ae", fillOpacity: 0.24, wireOpacity: 1 };
  }
  if (dimmed) {
    return { fill: "#64748b", wire: "#94a3b8", fillOpacity: 0.04, wireOpacity: 0.3 };
  }
  return { fill: "#60a5fa", wire: "#bfdbfe", fillOpacity: 0.08, wireOpacity: 0.56 };
}

function expandOverlayBounds(
  overlay: BuilderObjectOverlay,
  selected: boolean,
): BuilderObjectOverlay {
  if (!selected) {
    return overlay;
  }
  const extent = [
    overlay.boundsMax[0] - overlay.boundsMin[0],
    overlay.boundsMax[1] - overlay.boundsMin[1],
    overlay.boundsMax[2] - overlay.boundsMin[2],
  ] as const;
  const pad = Math.max(Math.max(...extent) * 0.05, 1e-12);
  return {
    ...overlay,
    boundsMin: [
      overlay.boundsMin[0] - pad,
      overlay.boundsMin[1] - pad,
      overlay.boundsMin[2] - pad,
    ],
    boundsMax: [
      overlay.boundsMax[0] + pad,
      overlay.boundsMax[1] + pad,
      overlay.boundsMax[2] + pad,
    ],
  };
}

function mapOverlayToFdmSceneBox(
  overlay: BuilderObjectOverlay | AntennaOverlayConductor,
  sceneMode: ViewportSceneMode,
  grid: [number, number, number],
  worldExtent: [number, number, number] | null,
  universeCenter?: [number, number, number] | null,
): { sceneMin: [number, number, number]; sceneMax: [number, number, number] } | null {
  if (sceneMode === "world") {
    return {
      sceneMin: physicalPositionToScene(overlay.boundsMin),
      sceneMax: physicalPositionToScene(overlay.boundsMax),
    };
  }
  if (!worldExtent) {
    return null;
  }
  const [nx, ny, nz] = grid;
  const domainCenter = universeCenter ?? [0, 0, 0];
  const domainMin = [
    domainCenter[0] - worldExtent[0] * 0.5,
    domainCenter[1] - worldExtent[1] * 0.5,
    domainCenter[2] - worldExtent[2] * 0.5,
  ] as const;
  const cell = [
    worldExtent[0] / Math.max(nx, 1),
    worldExtent[1] / Math.max(ny, 1),
    worldExtent[2] / Math.max(nz, 1),
  ] as const;
  const toSceneX = (value: number) => (value - domainMin[0]) / cell[0] - 0.5;
  const toSceneY = (value: number) => (value - domainMin[2]) / cell[2] - 0.5;
  const toSceneZ = (value: number) => (value - domainMin[1]) / cell[1] - 0.5;
  const sceneMin: [number, number, number] = [
    toSceneX(overlay.boundsMin[0]),
    toSceneY(overlay.boundsMin[2]),
    toSceneZ(overlay.boundsMin[1]),
  ];
  const sceneMax: [number, number, number] = [
    toSceneX(overlay.boundsMax[0]),
    toSceneY(overlay.boundsMax[2]),
    toSceneZ(overlay.boundsMax[1]),
  ];
  if (
    [...sceneMin, ...sceneMax].some((value) => !Number.isFinite(value)) ||
    sceneMax[0] <= sceneMin[0] ||
    sceneMax[1] <= sceneMin[1] ||
    sceneMax[2] <= sceneMin[2]
  ) {
    return null;
  }
  return { sceneMin, sceneMax };
}

function FdmObjectOverlayMeshes({
  overlays,
  selectedObjectId,
  objectViewMode,
  sceneMode,
  grid,
  worldExtent,
  universeCenter,
  onRequestObjectSelect,
  onGeometryTranslate,
}: {
  overlays: BuilderObjectOverlay[];
  selectedObjectId?: string | null;
  objectViewMode: ObjectViewMode;
  sceneMode: ViewportSceneMode;
  grid: [number, number, number];
  worldExtent?: [number, number, number] | null;
  universeCenter?: [number, number, number] | null;
  onRequestObjectSelect?: (id: string) => void;
  onGeometryTranslate?: (id: string, dx: number, dy: number, dz: number) => void;
}) {
  const hasSelected = Boolean(selectedObjectId);
  const cellX = worldExtent ? worldExtent[0] / Math.max(grid[0], 1) : 1;
  const cellY = worldExtent ? worldExtent[1] / Math.max(grid[1], 1) : 1;
  const cellZ = worldExtent ? worldExtent[2] / Math.max(grid[2], 1) : 1;

  return (
    <group>
      {overlays.map((overlay) => {
        const selected = selectedObjectId === overlay.id;
        const dimmed = hasSelected && !selected;
        if (objectViewMode === "isolate" && hasSelected && !selected) {
          return null;
        }
        const displayOverlay = expandOverlayBounds(overlay, selected);
        const mapped = mapOverlayToFdmSceneBox(displayOverlay, sceneMode, grid, worldExtent ?? null, universeCenter);
        if (!mapped) {
          return null;
        }
        const { sceneMin, sceneMax } = mapped;
        const size = [
          Math.max(sceneMax[0] - sceneMin[0], 0),
          Math.max(sceneMax[1] - sceneMin[1], 0),
          Math.max(sceneMax[2] - sceneMin[2], 0),
        ] as const;
        if (size.some((value) => !Number.isFinite(value) || value <= 0)) {
          return null;
        }
        const center = [
          0.5 * (sceneMin[0] + sceneMax[0]),
          0.5 * (sceneMin[1] + sceneMax[1]),
          0.5 * (sceneMin[2] + sceneMax[2]),
        ] as const;
        const colors = objectOverlayColors(selected, dimmed);
        const meshes = (
          <group>
            <mesh
              position={center}
              renderOrder={4}
              onClick={(e) => {
                e.stopPropagation();
                onRequestObjectSelect?.(overlay.id);
              }}
            >
              <boxGeometry args={size} />
              <meshStandardMaterial
                color={colors.fill}
                emissive={colors.fill}
                emissiveIntensity={selected ? 0.24 : 0.08}
                transparent
                opacity={colors.fillOpacity}
                depthWrite={false}
              />
            </mesh>
            <mesh position={center} renderOrder={5}>
              <boxGeometry args={size} />
              <meshBasicMaterial
                color={colors.wire}
                wireframe
                transparent
                opacity={colors.wireOpacity}
                depthWrite={false}
              />
            </mesh>
          </group>
        );

        if (selected && onGeometryTranslate) {
          return (
            <TransformGizmoLayer
              key={overlay.id}
              active
              scale={100}
              onTranslate={(dx, dy, dz) => {
                if (sceneMode === "world") {
                  const [physicalDx, physicalDy, physicalDz] = sceneDeltaToPhysical([dx, dy, dz]);
                  onGeometryTranslate(overlay.id, physicalDx, physicalDy, physicalDz);
                  return;
                }
                const physicalDx = dx * cellX;
                const physicalDz = dy * cellZ;
                const physicalDy = dz * cellY;
                onGeometryTranslate(overlay.id, physicalDx, physicalDy, physicalDz);
              }}
            >
              {meshes}
            </TransformGizmoLayer>
          );
        }

        return <group key={overlay.id}>{meshes}</group>;
      })}
    </group>
  );
}

function FdmUniverseBounds({
  worldExtent,
  universeCenter = null,
}: {
  worldExtent?: [number, number, number] | null;
  universeCenter?: [number, number, number] | null;
}) {
  const geometry = useMemo(() => {
    if (!worldExtent || !worldExtent.every((value) => Number.isFinite(value) && value > 0)) {
      return null;
    }
    const [sx, sy, sz] = physicalScaleToScene(worldExtent);
    return new THREE.BoxGeometry(sx, sy, sz);
  }, [worldExtent]);
  const center = useMemo(
    () => physicalPositionToScene(universeCenter ?? [0, 0, 0]),
    [universeCenter],
  );

  useEffect(() => () => geometry?.dispose(), [geometry]);

  if (!geometry) {
    return null;
  }

  return (
    <lineSegments position={center} renderOrder={3}>
      <edgesGeometry args={[geometry]} />
      <lineBasicMaterial color="#89b4fa" transparent opacity={0.5} depthWrite={false} />
    </lineSegments>
  );
}

function FdmAntennaOverlayMeshes({
  overlays,
  selectedAntennaId,
  sceneMode,
  grid,
  worldExtent,
  universeCenter,
  onAntennaTranslate,
}: {
  overlays: AntennaOverlay[];
  selectedAntennaId?: string | null;
  sceneMode: ViewportSceneMode;
  grid: [number, number, number];
  worldExtent?: [number, number, number] | null;
  universeCenter?: [number, number, number] | null;
  onAntennaTranslate?: (id: string, dx: number, dy: number, dz: number) => void;
}) {
  const cellX = worldExtent ? worldExtent[0] / Math.max(grid[0], 1) : 1;
  const cellY = worldExtent ? worldExtent[1] / Math.max(grid[1], 1) : 1;
  const cellZ = worldExtent ? worldExtent[2] / Math.max(grid[2], 1) : 1;

  return (
    <group>
      {overlays.map((overlay) => {
        const selected = selectedAntennaId === overlay.id;
        const conductors = overlay.conductors.map((conductor) => {
          const mapped = mapOverlayToFdmSceneBox(conductor, sceneMode, grid, worldExtent ?? null, universeCenter);
          if (!mapped) return null;
          const { sceneMin, sceneMax } = mapped;
          const size = [
            Math.max(sceneMax[0] - sceneMin[0], 0),
            Math.max(sceneMax[1] - sceneMin[1], 0),
            Math.max(sceneMax[2] - sceneMin[2], 0),
          ] as const;
          if (size.some((v) => !Number.isFinite(v) || v <= 0)) return null;
          const center = [
            0.5 * (sceneMin[0] + sceneMax[0]),
            0.5 * (sceneMin[1] + sceneMax[1]),
            0.5 * (sceneMin[2] + sceneMax[2]),
          ] as const;
          const colors = antennaOverlayColors(conductor.role, selected);
          return (
            <group key={conductor.id}>
              <mesh position={center} renderOrder={4}>
                <boxGeometry args={size} />
                <meshStandardMaterial
                  color={colors.fill}
                  emissive={colors.fill}
                  emissiveIntensity={selected ? 0.35 : 0.18}
                  transparent
                  opacity={selected ? 0.28 : 0.12}
                  depthWrite={false}
                />
              </mesh>
              <mesh position={center} renderOrder={5}>
                <boxGeometry args={size} />
                <meshBasicMaterial
                  color={colors.wire}
                  wireframe
                  transparent
                  opacity={selected ? 0.95 : 0.65}
                  depthWrite={false}
                />
              </mesh>
            </group>
          );
        });

        if (selected && onAntennaTranslate) {
          return (
            <TransformGizmoLayer
              key={overlay.id}
              active
              scale={100}
              onTranslate={(dx, dy, dz) => {
                if (sceneMode === "world") {
                  const [physicalDx, physicalDy, physicalDz] = sceneDeltaToPhysical([dx, dy, dz]);
                  onAntennaTranslate(overlay.id, physicalDx, physicalDy, physicalDz);
                  return;
                }
                const physicalDx = dx * cellX;
                const physicalDz = dy * cellZ;
                const physicalDy = dz * cellY;
                onAntennaTranslate(overlay.id, physicalDx, physicalDy, physicalDz);
              }}
            >
              <group>{conductors}</group>
            </TransformGizmoLayer>
          );
        }
        return <group key={overlay.id}>{conductors}</group>;
      })}
    </group>
  );
}

// ═══════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════
function UnifiedVectorFieldRendererInner({
  grid,
  vectors,
  vectorValueScale = 1,
  fieldLabel = "Vector Field",
  liveRenderDebugData = null,
  geometryMode = false,
  activeMask = null,
  worldExtent = null,
  objectOverlays = [],
  selectedObjectId = null,
  antennaOverlays = [],
  selectedAntennaId = null,
  onAntennaTranslate,
  universeCenter = null,
  focusObjectRequest = null,
  objectViewMode = "context",
  onRequestObjectSelect,
  onGeometryTranslate,
  activeTextureTransform = null,
  textureGizmoMode = "translate",
  activeTexturePreviewProxy = "box",
  onTextureTransformChange,
  onTextureTransformCommit,
  activeTransformScope,
  onTransformScopeChange,
  settings: externalSettings,
  viewport3DModel = null,
  onSettingsChange,
  toolbarMode = "visible",
  viewportAxesScope = "universe",
  universeWireframeVisible = true,
  viewportVisible = true,
  viewportDocumentId = null,
  persistedCameraState = null,
  onPersistCameraState,
  onCameraInteractionChange,
  authoringOverlay = null,
}: Props) {
  const { hostRef, hostNode } = useCanvasHost<HTMLDivElement>();
  const { settings: baseViewportSettings, update } = useVectorSurfaceViewportSettings({
    externalSettings,
    onSettingsChange,
  });
  const settings = useMemo(
    () => settingsFromViewport3DModel(baseViewportSettings, viewport3DModel),
    [baseViewportSettings, viewport3DModel],
  );
  const canvasDpr = settings.quality === "ultra"
    ? Math.min(typeof window !== "undefined" ? window.devicePixelRatio : 1, 2)
    : 1;
  const frameloop = resolveViewportFrameloop({
    hidden: !viewportVisible,
    renderMode: "demand",
    forcedFrameloopMode: String(FRONTEND_DIAGNOSTIC_FLAGS.viewportCore.frameloopMode) as
      | "always"
      | "demand"
      | "never",
  });
  const telemetry = useViewportTelemetryEntry({
    label: "vector-surface-viewport",
    renderer: "webgl",
    frameloop,
    hidden: !viewportVisible,
  });
  const recordFdmTopologyRebuild = useCallback(() => {
    telemetry.recordLifecycleEvent("topology_rebuild");
  }, [telemetry]);
  const recordFdmFieldBufferUpdate = useCallback(() => {
    telemetry.recordLifecycleEvent("field_buffer_update");
  }, [telemetry]);
  const [openPopover, setOpenPopover] = useState<"color" | "display" | "topo" | "camera" | "info" | "rotation" | null>(null);
  const renderCountRef = useRef(0);
  const lastPersistLogAtMsRef = useRef(0);

  // ── 3dsmax-style interaction mode (camera / move / rotate / scale) ──
  type InteractionMode = "camera" | "move" | "rotate" | "scale";
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("camera");
  const cameraActive = interactionMode === "camera";

  // Switch back to camera when activeTextureTransform disappears
  useEffect(() => {
     
    if (!activeTextureTransform) setInteractionMode("camera");
  }, [activeTextureTransform]);

  useEffect(() => {
    if (!activeTextureTransform) {
      return;
    }
     
    setInteractionMode(
      textureGizmoMode === "rotate"
        ? "rotate"
        : textureGizmoMode === "scale"
          ? "scale"
          : "move",
    );
  }, [activeTextureTransform, textureGizmoMode]);

  // Keyboard shortcuts: Q=camera, W=move, E=rotate, R=scale (only when gizmo available)
  useEffect(() => {
    if (!activeTextureTransform) return;
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (e.key === "q" || e.key === "Q" || e.key === "Escape") setInteractionMode("camera");
      else if (e.key === "w" || e.key === "W") setInteractionMode("move");
      else if (e.key === "e" || e.key === "E") setInteractionMode("rotate");
      else if (e.key === "r" || e.key === "R") setInteractionMode("scale");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTextureTransform]);

  // Derive gizmo mode from interaction mode
  const derivedGizmoMode: TextureGizmoMode =
    interactionMode === "rotate" ? "rotate" :
    interactionMode === "scale"  ? "scale"  : "translate";
  // Hidden viewport should not consume high-frequency vector updates.
  const modelVectorField = viewport3DModel?.vectorField ?? null;
  const modelVectorData =
    !geometryMode && isViewport3DVectorFieldRenderable(modelVectorField)
      ? modelVectorField?.data ?? null
      : null;
  const effectiveVectors = modelVectorData?.values ?? vectors;
  const effectiveGrid =
    modelVectorData?.grid && modelVectorData.grid.every((value) => value > 0)
      ? modelVectorData.grid
      : grid;
  const renderVectors = useMemo(
    () => toVectorSurfaceRenderBuffer(effectiveVectors, vectorValueScale),
    [effectiveVectors, vectorValueScale],
  );
  const deferredVectors = useDeferredValue(renderVectors);
  const deferredGrid = useDeferredValue(effectiveGrid);
  const deferredSettings = useDeferredValue(settings);
  // Vectors-visible flag from toolbar (glyph mode toggle).
  const vectorsVisible = viewport3DModel?.fdm?.vectorsVisible ?? true;
  const renderedVectorSample = useMemo(
    () => buildRenderedVectorSample(deferredVectors),
    [deferredVectors],
  );
  const renderedVectorCount = deferredVectors ? Math.floor(deferredVectors.length / 3) : 0;

  const controlsRef = useRef<any>(null);
  const viewCubeSceneRef = useRef<any>(null);
  const cameraInteractionActiveRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glRef = useRef<THREE.WebGLRenderer | null>(null);
  const r3fSceneRef = useRef<THREE.Scene | null>(null);
  const r3fCameraRef = useRef<THREE.Camera | null>(null);
  const canvasContextCleanupRef = useRef<(() => void) | null>(null);
  const [canvasContextGeneration, setCanvasContextGeneration] = useState(0);
  const [rotationSnapshots, setRotationSnapshots] = useState<Record<RotationPanelKey, OrientationDebugSnapshot | null>>({
    viewport: null,
    viewCube: null,
    hsl: null,
  });
  const [nx, ny, nz] = deferredGrid;
  const hasRenderableGrid = nx > 0 && ny > 0 && nz > 0;
  const sceneMode: ViewportSceneMode = geometryMode
    ? "world"
    : hasRenderableGrid
      ? "grid"
      : "world";
  const overlayBounds = useMemo(() => combineOverlayBounds(objectOverlays), [objectOverlays]);
  const worldBounds = useMemo(() => {
    if (worldExtent && worldExtent.every((value) => Number.isFinite(value) && value > 0)) {
      const center = universeCenter ?? [0, 0, 0];
      return {
        min: [
          center[0] - worldExtent[0] * 0.5,
          center[1] - worldExtent[1] * 0.5,
          center[2] - worldExtent[2] * 0.5,
        ] as [number, number, number],
        max: [
          center[0] + worldExtent[0] * 0.5,
          center[1] + worldExtent[1] * 0.5,
          center[2] + worldExtent[2] * 0.5,
        ] as [number, number, number],
      };
    }
    return overlayBounds;
  }, [overlayBounds, universeCenter, worldExtent]);
  const sceneFrame = useMemo(() => {
    if (sceneMode === "grid") {
      return {
        center: [nx / 2, nz / 2, ny / 2] as [number, number, number],
        extent: [nx, nz, ny] as [number, number, number],
      };
    }
    if (!worldBounds) {
      return {
        center: [0, 0, 0] as [number, number, number],
        extent: [1, 1, 1] as [number, number, number],
      };
    }
    return {
      center: physicalPositionToScene([
        0.5 * (worldBounds.min[0] + worldBounds.max[0]),
        0.5 * (worldBounds.min[1] + worldBounds.max[1]),
        0.5 * (worldBounds.min[2] + worldBounds.max[2]),
      ]),
      extent: physicalScaleToScene([
        Math.max(worldBounds.max[0] - worldBounds.min[0], 1e-9),
        Math.max(worldBounds.max[1] - worldBounds.min[1], 1e-9),
        Math.max(worldBounds.max[2] - worldBounds.min[2], 1e-9),
      ]),
    };
  }, [nx, ny, nz, sceneMode, worldBounds]);
  const [cx, cy, cz] = sceneFrame.center;
  const orbitDist = Math.max(...sceneFrame.extent, 1) * 1.5;
  const sceneTarget = sceneFrame.center;
  // P-20 fix: capture the orbit pivot once so step-update JSON (which produces new worldExtent
  // array references with the same values) does not cause TrackballControls to snap back to
  // center via its reactive `target` useEffect. If the geometry changes substantially the user
  // can use the fit-to-bounds control; no auto-reset on every poll tick.
  const [stableOrbitTarget, setStableOrbitTarget] = useState<[number, number, number]>(
    () => [...sceneFrame.center] as [number, number, number],
  );
  const vectorSurfaceCameraFitSignature = useMemo(
    () =>
      buildVectorSurfaceCameraFitSignature({
        viewportVisible,
        sceneMode,
        hasRenderableContent: sceneMode === "grid" ? hasRenderableGrid : Boolean(worldBounds),
        center: sceneFrame.center,
        extent: sceneFrame.extent,
      }),
    [hasRenderableGrid, sceneFrame.center, sceneFrame.extent, sceneMode, viewportVisible, worldBounds],
  );
  const vectorSurfaceCameraFitMaxDim = Math.max(...sceneFrame.extent, 1);
  const cameraPersistenceKey = useMemo(
    () =>
      viewportDocumentId
        ? `viewport-doc:${viewportDocumentId}`
        : sceneMode === "grid"
        ? `fdm:${geometryMode ? "mesh" : "3d"}:${deferredGrid.join("x")}`
        : `fdm:world:${sceneTarget.join("x")}:${sceneFrame.extent.join("x")}`,
    [deferredGrid, geometryMode, sceneFrame.extent, sceneMode, sceneTarget, viewportDocumentId],
  );
  const clearVectorSurfaceCanvasRefs = useCallback(() => {
    canvasRef.current = null;
    glRef.current = null;
    r3fSceneRef.current = null;
    r3fCameraRef.current = null;
  }, []);
  const remountVectorSurfaceCanvas = useCallback(() => {
    clearVectorSurfaceCanvasRefs();
    logVectorSurfaceDebug("webgl remount requested", {
      key: cameraPersistenceKey,
    });
    setCanvasContextGeneration((generation) => generation + 1);
  }, [cameraPersistenceKey, clearVectorSurfaceCanvasRefs]);
  const {
    handleContextLost,
    handleContextRestored,
    clearRetryTimer: clearContextLossRetryTimer,
  } = useViewportContextLossRecovery({
    hidden: !viewportVisible,
    onRemount: remountVectorSurfaceCanvas,
    onContextLost: () => {
      telemetry.recordLifecycleEvent("context_lost");
    },
    onRecoveryScheduled: (decision) => {
      clearVectorSurfaceCanvasRefs();
      logVectorSurfaceDebug("webgl context lost", {
        key: cameraPersistenceKey,
        generation: canvasContextGeneration,
        retryDelayMs: decision.retryDelayMs,
      });
    },
    onRecoveryBlocked: (decision) => {
      logVectorSurfaceDebug("webgl context lost; automatic remount blocked", {
        key: cameraPersistenceKey,
        generation: canvasContextGeneration,
        retryCount: decision.nextTimestamps.length,
      });
    },
    onContextRestored: () => {
      telemetry.recordLifecycleEvent("context_restored");
      logVectorSurfaceDebug("webgl context restored", {
        key: cameraPersistenceKey,
        generation: canvasContextGeneration,
      });
    },
  });
  const cameraRestoreReadyRef = useRef(false);
  const lastRestoredCameraRef = useRef<{
    key: string;
    state: ViewportCameraState | null;
  } | null>(null);
  const lastVectorSurfaceCameraFitSignatureRef = useRef<string | null>(null);
  const lastFocusedObjectIdRef = useRef<string | null>(persistedCameraState?.lastFocusedObjectId ?? null);
  // P-26: Track the last persisted camera state we actually applied. Used to detect reference-
  // identity changes that carry identical values (e.g., when the workspace graph snapshot
  // rebuilds because a new scalar row arrived during solver relaxation), so we don't
  // hard-set the camera unnecessarily.
  const lastAppliedPersistedStateRef = useRef<ViewportCameraState | null>(null);
  renderCountRef.current += 1;
  if (VECTOR_SURFACE_DEBUG_LOGS) {
    logVectorSurfaceDebug("render", {
      renderCount: renderCountRef.current,
      viewportDocumentId,
      cameraPersistenceKey,
      canvasContextGeneration,
      viewportVisible,
      hasPersistedCameraState: Boolean(persistedCameraState),
    });
  }
  useEffect(() => {
    logVectorSurfaceDebug("mount", {
      viewportDocumentId,
      cameraPersistenceKey,
    });
    return () => {
      logVectorSurfaceDebug("unmount", {
        viewportDocumentId,
        cameraPersistenceKey,
      });
    };
  }, [cameraPersistenceKey, viewportDocumentId]);
  const rotationSnapshotsEnabled =
    toolbarMode !== "hidden" &&
    FRONTEND_DIAGNOSTIC_FLAGS.vectorSurfaceViewport.showToolbar &&
    FRONTEND_DIAGNOSTIC_FLAGS.vectorSurfaceViewport.enableRotationDebugControls;
  const updateRotationSnapshot = useCallback((key: RotationPanelKey, snapshot: OrientationDebugSnapshot) => {
    if (!rotationSnapshotsEnabled) {
      return;
    }
    setRotationSnapshots((previous) => {
      const current = previous[key];
      if (
        current?.signature === snapshot.signature &&
        current.cssTransform === snapshot.cssTransform
      ) {
        return previous;
      }
      return { ...previous, [key]: snapshot };
    });
  }, [rotationSnapshotsEnabled]);
  const syncViewportRotationSnapshot = useCallback(() => {
    const bridge = viewCubeSceneRef.current;
    if (!bridge?.camera) {
      return;
    }
    updateRotationSnapshot("viewport", captureOrientationDebugSnapshot(bridge.camera));
  }, [updateRotationSnapshot]);
  useEffect(() => {
    if (rotationSnapshotsEnabled) {
      syncViewportRotationSnapshot();
    }
  }, [rotationSnapshotsEnabled, syncViewportRotationSnapshot]);
  const persistCameraState = useCallback(() => {
    if (!viewportVisible) {
      return;
    }
    if (cameraInteractionActiveRef.current) {
      return;
    }
    if (!cameraRestoreReadyRef.current) {
      return;
    }
    const bridge = viewCubeSceneRef.current;
    const state = captureViewportCameraState(bridge, {
      projection: "perspective",
      navigation: "trackball",
      lastFocusedObjectId: lastFocusedObjectIdRef.current,
    });
    if (!state) {
      return;
    }
    const now = Date.now();
    if (VECTOR_SURFACE_DEBUG_LOGS && now - lastPersistLogAtMsRef.current >= 800) {
      lastPersistLogAtMsRef.current = now;
      logVectorSurfaceDebug("camera persist", {
        key: cameraPersistenceKey,
        position: state.position,
        target: state.target,
      });
    }
    if (onPersistCameraState) {
      telemetry.recordLifecycleEvent("camera_persist");
      onPersistCameraState(state);
      return;
    }
    telemetry.recordLifecycleEvent("camera_persist");
    VECTOR_SURFACE_CAMERA_STATE_CACHE.set(cameraPersistenceKey, {
      position: state.position,
      up: state.up,
      target: state.target,
    });
  }, [cameraPersistenceKey, onPersistCameraState, telemetry, viewportVisible]);
  const cameraPersistenceController = useViewportCameraPersistenceController(persistCameraState);
  const handleCameraInteractionChange = useCallback((active: boolean) => {
    cameraInteractionActiveRef.current = active;
    cameraPersistenceController.setInteractionActive(active);
    onCameraInteractionChange?.(active);
  }, [cameraPersistenceController, onCameraInteractionChange]);
  const handleCameraInteractionStart = useCallback(() => {
    handleCameraInteractionChange(true);
  }, [handleCameraInteractionChange]);
  const handleCameraInteractionEnd = useCallback(() => {
    handleCameraInteractionChange(false);
  }, [handleCameraInteractionChange]);
  const handleSceneCameraChange = useCallback(() => {
    if (!viewportVisible) {
      return;
    }
    syncViewportRotationSnapshot();
    cameraPersistenceController.schedule();
  }, [cameraPersistenceController, syncViewportRotationSnapshot, viewportVisible]);
  useSceneCameraChange(viewCubeSceneRef, handleSceneCameraChange, {
    onInteractionStart: handleCameraInteractionStart,
    onInteractionEnd: handleCameraInteractionEnd,
  });
  useEffect(() => {
    let raf = 0;
    let disposed = false;

    const restore = () => {
      if (disposed) {
        return;
      }
      const bridge = viewCubeSceneRef.current;
      if (!bridge?.camera || !bridge?.controls) {
        raf = window.requestAnimationFrame(restore);
        return;
      }
      // P-26: Skip restore when persistedCameraState changed reference but
      // values are identical to what we already applied. This prevents a
      // camera snapback when the parent re-creates the camera object because
      // an unrelated viewport document field changed (e.g., solver scalar row).
      if (
        shouldSkipViewportCameraRestoreForAppliedState({
          restoreReady: cameraRestoreReadyRef.current,
          persistedCameraState,
          lastAppliedCameraState: lastAppliedPersistedStateRef.current,
        })
      ) {
        logVectorSurfaceDebug("camera restore skipped (same persisted state)", {
          key: cameraPersistenceKey,
        });
        syncViewportRotationSnapshot();
        return;
      }
      const currentState = captureViewportCameraState(bridge, {
        projection: "perspective",
        navigation: "trackball",
        lastFocusedObjectId: lastFocusedObjectIdRef.current,
      });
      if (
        shouldSkipViewportCameraRestoreForRestoredState({
          restoreReady: cameraRestoreReadyRef.current,
          cameraKey: cameraPersistenceKey,
          persistedCameraState,
          currentCameraState: currentState,
          lastRestoredCamera: lastRestoredCameraRef.current,
        })
      ) {
        syncViewportRotationSnapshot();
        return;
      }
      if (
        isViewportCameraAlreadyAtPersistedState({
          persistedCameraState,
          currentCameraState: currentState,
        })
      ) {
        lastRestoredCameraRef.current = {
          key: cameraPersistenceKey,
          state: persistedCameraState,
        };
        cameraRestoreReadyRef.current = true;
        lastAppliedPersistedStateRef.current = persistedCameraState;  // P-26
        logVectorSurfaceDebug("camera already at persisted state", {
          key: cameraPersistenceKey,
        });
        syncViewportRotationSnapshot();
        return;
      }

      cameraRestoreReadyRef.current = false;
      const restored =
        restoreViewportCameraState(bridge, persistedCameraState) ||
        (() => {
          const saved = VECTOR_SURFACE_CAMERA_STATE_CACHE.get(cameraPersistenceKey);
          if (!saved) {
            return false;
          }
          bridge.camera.position.set(...saved.position);
          bridge.camera.up.set(...saved.up);
          bridge.controls.target.set(...saved.target);
          bridge.camera.lookAt(...saved.target);
          bridge.controls.update();
          return true;
        })();
      if (restored) {
        telemetry.recordLifecycleEvent("camera_restore");
        lastFocusedObjectIdRef.current = persistedCameraState?.lastFocusedObjectId ?? null;
        logVectorSurfaceDebug("camera restored", {
          key: cameraPersistenceKey,
          position: persistedCameraState?.position ?? null,
          target: persistedCameraState?.target ?? null,
        });
      } else {
        logVectorSurfaceDebug("camera restore skipped (missing bridge or state)", {
          key: cameraPersistenceKey,
          hasPersistedCameraState: Boolean(persistedCameraState),
        });
      }
      lastRestoredCameraRef.current = {
        key: cameraPersistenceKey,
        state: persistedCameraState ?? null,
      };
      cameraRestoreReadyRef.current = true;
      lastAppliedPersistedStateRef.current = persistedCameraState;  // P-26
      syncViewportRotationSnapshot();
    };

    restore();

    return () => {
      disposed = true;
      if (raf) {
        window.cancelAnimationFrame(raf);
      }
    };
  }, [cameraPersistenceKey, persistedCameraState, syncViewportRotationSnapshot, telemetry]);

  useEffect(() => {
    if (!vectorSurfaceCameraFitSignature) {
      return;
    }
    if (
      !shouldApplyVectorSurfaceCameraAutoFit({
        nextFitSignature: vectorSurfaceCameraFitSignature,
        previousFitSignature: lastVectorSurfaceCameraFitSignatureRef.current,
        persistedCameraAvailable: Boolean(persistedCameraState),
        cameraInteractionActive: cameraInteractionActiveRef.current,
      })
    ) {
      return;
    }

    let raf = 0;
    let disposed = false;

    const fit = () => {
      if (disposed) {
        return;
      }
      const bridge = viewCubeSceneRef.current;
      if (!bridge?.camera || !bridge?.controls) {
        raf = window.requestAnimationFrame(fit);
        return;
      }

      const target = new THREE.Vector3(cx, cy, cz);
      fitCameraToBounds(
        bridge.camera,
        vectorSurfaceCameraFitMaxDim,
        target,
        bridge.controls,
      );
      setStableOrbitTarget([target.x, target.y, target.z]);
      lastVectorSurfaceCameraFitSignatureRef.current = vectorSurfaceCameraFitSignature;
      telemetry.recordLifecycleEvent("camera_fit");
      syncViewportRotationSnapshot();
    };

    fit();

    return () => {
      disposed = true;
      if (raf) {
        window.cancelAnimationFrame(raf);
      }
    };
  }, [
    cx,
    cy,
    cz,
    persistedCameraState,
    syncViewportRotationSnapshot,
    telemetry,
    vectorSurfaceCameraFitMaxDim,
    vectorSurfaceCameraFitSignature,
  ]);

  // Snap camera to a direction
  const snapCamera = useCallback((dir: [number, number, number], up: [number, number, number] = [0, 1, 0]) => {
    const bridge = viewCubeSceneRef.current;
    if (!bridge?.camera || !bridge?.controls) return;
    const { camera, controls } = bridge;
    const len = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
    const n = len > 0 ? [dir[0] / len, dir[1] / len, dir[2] / len] : [0, 0, 1];
    camera.position.set(
      cx + n[0] * orbitDist,
      cy + n[1] * orbitDist,
      cz + n[2] * orbitDist,
    );
    camera.up.set(up[0], up[1], up[2]);
    camera.lookAt(cx, cy, cz);
    controls.target.set(cx, cy, cz);
    controls.update();
    setStableOrbitTarget([cx, cy, cz]);
  }, [cx, cy, cz, orbitDist]);

  const resetCamera = useCallback(
    () => snapCamera(DEFAULT_CAMERA_DIRECTION, DEFAULT_CAMERA_UP),
    [snapCamera],
  );

  const handleViewCubeRotate = useCallback((quat: THREE.Quaternion) => {
    const bridge = viewCubeSceneRef.current;
    if (!bridge?.camera || !bridge?.controls) return;
    rotateCameraAroundTarget(bridge.camera, bridge.controls, quat);
  }, []);

  const focusObject = useCallback((objectId: string) => {
    if (sceneMode === "grid" && !worldExtent) {
      return;
    }
    const overlay = objectOverlays.find((candidate) => candidate.id === objectId);
    const bridge = viewCubeSceneRef.current;
    if (!overlay || !bridge?.camera || !bridge?.controls) {
      return;
    }
    lastFocusedObjectIdRef.current = objectId;
    const mapped = mapOverlayToFdmSceneBox(overlay, sceneMode, grid, worldExtent, universeCenter);
    if (!mapped) {
      return;
    }
    focusCameraOnBounds(
      bridge.camera,
      bridge.controls,
      { min: mapped.sceneMin, max: mapped.sceneMax },
      { fallbackMinRadius: sceneMode === "world" ? Math.max(orbitDist * 0.1, 1e-6) : 1.5 },
    );
    setStableOrbitTarget([
      bridge.controls.target.x,
      bridge.controls.target.y,
      bridge.controls.target.z,
    ]);
  }, [grid, objectOverlays, orbitDist, sceneMode, universeCenter, worldExtent]);

  useEffect(() => {
    if (!focusObjectRequest) {
      return;
    }
    focusObject(focusObjectRequest.objectId);
  }, [focusObject, focusObjectRequest]);

  // Capture viewport as PNG — render a fresh frame and read immediately so
  // that preserveDrawingBuffer can stay disabled during normal interaction.
  const captureSnapshot = useCallback(() => {
    const gl = glRef.current;
    const scene = r3fSceneRef.current;
    const camera = r3fCameraRef.current;
    if (!gl || !scene || !camera) return;
    gl.render(scene, camera);
    const link = document.createElement("a");
    link.download = `fullmag_3d_${Date.now()}.png`;
    link.href = gl.domElement.toDataURL("image/png");
    link.click();
  }, []);

  useEffect(() => {
    return () => {
      canvasContextCleanupRef.current?.();
      canvasContextCleanupRef.current = null;
      clearContextLossRetryTimer();
      clearVectorSurfaceCanvasRefs();
    };
  }, [clearContextLossRetryTimer, clearVectorSurfaceCanvasRefs]);

  const selectedAxesOverlay = useMemo(
    () => selectedObjectId
      ? objectOverlays.find((candidate) => candidate.id === selectedObjectId) ?? null
      : null,
    [objectOverlays, selectedObjectId],
  );
  const selectedAxesSceneBox = useMemo(
    () => selectedAxesOverlay
      ? mapOverlayToFdmSceneBox(
          selectedAxesOverlay,
          sceneMode,
          grid,
          worldExtent,
          universeCenter,
        )
      : null,
    [grid, sceneMode, selectedAxesOverlay, universeCenter, worldExtent],
  );

  // SceneAxes3D props — vector-surface coordinate mapping: scene-X=sim-X, scene-Y=sim-Z, scene-Z=sim-Y
  const objectAxesWorldExtent = selectedAxesOverlay
    ? [
        selectedAxesOverlay.boundsMax[0] - selectedAxesOverlay.boundsMin[0],
        selectedAxesOverlay.boundsMax[2] - selectedAxesOverlay.boundsMin[2],
        selectedAxesOverlay.boundsMax[1] - selectedAxesOverlay.boundsMin[1],
      ] as [number, number, number]
    : null;
  const universeAxesWorldExtent = worldExtent
    ? [worldExtent[0], worldExtent[2], worldExtent[1]] as [number, number, number]
    : null;
  const axesWorldExtent =
    viewportAxesScope === "object" && objectAxesWorldExtent
      ? objectAxesWorldExtent
      : universeAxesWorldExtent;
  const axesCenter = viewportAxesScope === "object" && selectedAxesSceneBox
    ? [
        (selectedAxesSceneBox.sceneMin[0] + selectedAxesSceneBox.sceneMax[0]) * 0.5,
        (selectedAxesSceneBox.sceneMin[1] + selectedAxesSceneBox.sceneMax[1]) * 0.5,
        (selectedAxesSceneBox.sceneMin[2] + selectedAxesSceneBox.sceneMax[2]) * 0.5,
      ] as [number, number, number]
    : sceneTarget;
  const axesSceneScale: [number, number, number] = axesWorldExtent
    ? sceneMode === "world"
      ? [1, 1, 1]
      : [
          axesWorldExtent[0] > 0 ? nx / axesWorldExtent[0] : 1,
          axesWorldExtent[1] > 0 ? nz / axesWorldExtent[1] : 1,
          axesWorldExtent[2] > 0 ? ny / axesWorldExtent[2] : 1,
        ]
    : [1, 1, 1];
  // In isolate mode, keep voxels at full opacity to avoid transparent instanced mesh
  // sorting artifacts. The overlay boxes already hide non-selected objects visually.
  const sceneOpacityMultiplier = 1;

  // Compute grid-space isolate bounds so instance rendering hides voxels outside
  // the selected object when in isolate mode.
  const isolateGridBounds = useMemo(() => {
    if (sceneMode !== "grid") return null;
    if (objectViewMode !== "isolate" || !selectedObjectId || !worldExtent) return null;
    const overlay = objectOverlays.find((o) => o.id === selectedObjectId);
    if (!overlay) return null;
    const domainCenter = universeCenter ?? [0, 0, 0];
    const domainMin = [
      domainCenter[0] - worldExtent[0] * 0.5,
      domainCenter[1] - worldExtent[1] * 0.5,
      domainCenter[2] - worldExtent[2] * 0.5,
    ] as const;
    const cellX = worldExtent[0] / Math.max(nx, 1);
    const cellY = worldExtent[1] / Math.max(ny, 1);
    const cellZ = worldExtent[2] / Math.max(nz, 1);
    const toIx = (wx: number) => (wx - domainMin[0]) / cellX - 0.5;
    const toIy = (wy: number) => (wy - domainMin[1]) / cellY - 0.5;
    const toIz = (wz: number) => (wz - domainMin[2]) / cellZ - 0.5;
    return {
      minIx: Math.floor(toIx(overlay.boundsMin[0])),
      maxIx: Math.ceil(toIx(overlay.boundsMax[0])),
      minIy: Math.floor(toIy(overlay.boundsMin[1])),
      maxIy: Math.ceil(toIy(overlay.boundsMax[1])),
      minIz: Math.floor(toIz(overlay.boundsMin[2])),
      maxIz: Math.ceil(toIz(overlay.boundsMax[2])),
    };
  }, [objectViewMode, sceneMode, selectedObjectId, objectOverlays, worldExtent, universeCenter, nx, ny, nz]);

  const toolbarOptionClassName =
    "appearance-none border border-transparent bg-transparent text-muted-foreground text-[0.65rem] font-semibold uppercase px-2 py-1 rounded cursor-pointer transition-colors hover:bg-muted/40 hover:text-foreground data-[active=true]:border-primary/45 data-[active=true]:bg-primary/18 data-[active=true]:text-primary";
  const vectorSurfaceFlags = FRONTEND_DIAGNOSTIC_FLAGS.vectorSurfaceViewport;
  const showInternalToolbar = toolbarMode !== "hidden" && vectorSurfaceFlags.showToolbar;
  const showInternalToolbarControls = showInternalToolbar;
  const showInternalStatusChip = vectorSurfaceFlags.showStatusChip;
  const showTextureScopeToolbar =
    showInternalToolbar && vectorSurfaceFlags.showTextureModeToolbar;
  const showViewCube =
    vectorSurfaceFlags.showViewCube && FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showViewCube;
  const showOrientationSphere = shouldShowVectorSurfaceOrientationReference({
    viewportVisible,
    geometryMode,
    viewport3DModel,
    orientationReferenceKillSwitch: FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showOrientationSphere,
  });
  const showRenderModeControls =
    showInternalToolbarControls &&
    vectorSurfaceFlags.enableRenderModeControls &&
    !geometryMode;
  const showColorControls =
    showInternalToolbarControls &&
    vectorSurfaceFlags.enableColorControls &&
    settings.renderMode === "voxel";
  const showDisplayControls =
    showInternalToolbarControls && vectorSurfaceFlags.enableDisplayControls;
  const showTopographyControls =
    showInternalToolbarControls &&
    vectorSurfaceFlags.enableTopographyControls &&
    !geometryMode;
  const showCameraControls =
    showInternalToolbarControls && vectorSurfaceFlags.enableCameraControls;
  const showRotationDebugControls =
    showInternalToolbarControls && vectorSurfaceFlags.enableRotationDebugControls;
  const showInfoControls =
    showInternalToolbarControls && vectorSurfaceFlags.enableInfoControls;
  const showSnapshotControl =
    showInternalToolbarControls && vectorSurfaceFlags.enableSnapshotControl;
  const showToolbarActionGroup =
    showDisplayControls ||
    showTopographyControls ||
    showCameraControls ||
    showRotationDebugControls ||
    showInfoControls ||
    showSnapshotControl;
  const hasTopLeftToolbarContent =
    showInternalStatusChip ||
    showRenderModeControls ||
    showColorControls ||
    showToolbarActionGroup;
  const showLiveRenderDebugPanel =
    FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging &&
    vectorSurfaceFlags.showLiveRenderDebugPanel;
  const showFieldLegend = Boolean(
    viewport3DModel?.overlays.legendVisible && viewportVisible && !geometryMode,
  );
  const legendModeLabel = formatLegendMode(settings);

  return (
    <div className="relative flex flex-col h-full">
      {/* ── Overlay Layout ────────────────────────────────────── */}
      <ViewportOverlayLayout>
        <ViewportOverlayLayout.TopLeft>
          {hasTopLeftToolbarContent ? (
          <ViewportToolbar3D>
            {/* Render mode */}
            {showRenderModeControls && (
              <ViewportToolGroup label="Render">
                <ViewportIconAction
                  icon={<ArrowUpRight size={14} />}
                  active={settings.renderMode === "glyph"}
                  onClick={() => update({ renderMode: "glyph" })}
                  title="Arrows"
                />
                <ViewportIconAction
                  icon={<Box size={14} />}
                  active={settings.renderMode === "voxel"}
                  onClick={() => update({ renderMode: "voxel" })}
                  title="Voxel"
                />
              </ViewportToolGroup>
            )}

            {showRenderModeControls && (showColorControls || showInternalStatusChip || showToolbarActionGroup)
              ? <ViewportToolSeparator />
              : null}

            {/* Color field (only voxel) */}
            {showColorControls && (
              <ViewportToolGroup label="Color">
                <ViewportPopoverTrigger preferredHorizontal="left">
                  <ViewportIconAction
                    icon={<Palette size={14} />}
                    label={settings.voxelColorMode === "orientation" ? "ORI" : settings.voxelColorMode.toUpperCase()}
                    active={openPopover === "color"}
                    showCaret
                    onClick={() => setOpenPopover(prev => prev === "color" ? null : "color")}
                    title="Color Field"
                  />
                  {openPopover === "color" && (
                    <ViewportPopoverPanel anchorRef={{ current: null }} title="Color Mode">
                       <ViewportPopoverRow label="Field">
                        {(["orientation", "x", "y", "z"] as VoxelColorMode[]).map(v => (
                           <button key={v} className={toolbarOptionClassName} data-active={settings.voxelColorMode === v} onClick={() => { update({ voxelColorMode: v }); setOpenPopover(null); }}>
                             {v === "orientation" ? "ORI" : v.toUpperCase()}
                           </button>
                        ))}
                      </ViewportPopoverRow>
                    </ViewportPopoverPanel>
                  )}
                </ViewportPopoverTrigger>
              </ViewportToolGroup>
            )}

            {showColorControls && (showInternalStatusChip || showToolbarActionGroup)
              ? <ViewportToolSeparator />
              : null}

            {showInternalStatusChip ? (
              <ViewportStatusChip color="info">{fieldLabel ?? "M"}</ViewportStatusChip>
            ) : null}

            {showInternalStatusChip && showToolbarActionGroup
              ? <ViewportToolSeparator />
              : null}

            {showToolbarActionGroup ? <ViewportToolGroup>
              {/* Display settings Popover */}
              {showDisplayControls ? <ViewportPopoverTrigger preferredHorizontal="left">
                <ViewportIconAction
                  icon={<Eye size={14} />}
                  showCaret
                  active={openPopover === "display"}
                  onClick={() => setOpenPopover(prev => prev === "display" ? null : "display")}
                  title="Display Options"
                />
                {openPopover === "display" && (
                  <ViewportPopoverPanel anchorRef={{ current: null }} title="Display & Quality">
                    <ViewportPopoverRow label="Quality">
                       {(["low", "high", "ultra"] as QualityLevel[]).map(v => (
                           <button key={v} className={toolbarOptionClassName} data-active={settings.quality === v} onClick={() => update({ quality: v })}>
                             {v}
                           </button>
                        ))}
                    </ViewportPopoverRow>
                    <ViewportPopoverRow label="Brightness">
                       <input type="range" className="flex-1 h-[3px] accent-primary max-w-[120px]" min={0.3} max={3.0} step={0.1} value={settings.brightness} onChange={(e) => update({ brightness: parseFloat(e.target.value) })} />
                    </ViewportPopoverRow>
                    {settings.renderMode === "voxel" && (
                      <>
                        <div className="h-px bg-border/20 my-1"/>
                        <ViewportPopoverRow label="Opacity">
                           <input type="range" className="flex-1 h-[3px] accent-primary max-w-[120px]" min={0.15} max={0.95} step={0.01} value={settings.voxelOpacity} onChange={(e) => update({ voxelOpacity: parseFloat(e.target.value) })} />
                        </ViewportPopoverRow>
                        <ViewportPopoverRow label="Spacing">
                           <input type="range" className="flex-1 h-[3px] accent-primary max-w-[120px]" min={0.02} max={0.42} step={0.01} value={settings.voxelGap} onChange={(e) => update({ voxelGap: parseFloat(e.target.value) })} />
                        </ViewportPopoverRow>
                        <ViewportPopoverRow label="Min Str">
                           <input type="range" className="flex-1 h-[3px] accent-primary max-w-[120px]" min={0} max={0.95} step={0.01} value={settings.voxelThreshold} onChange={(e) => update({ voxelThreshold: parseFloat(e.target.value) })} />
                        </ViewportPopoverRow>
                        <ViewportPopoverRow label="Sampling">
                           {(["1", "2", "4"]).map(v => (
                             <button key={v} className={toolbarOptionClassName} data-active={String(settings.sampling) === v} onClick={() => update({ sampling: parseInt(v, 10) as VoxelSampling })}>
                               {v}X
                             </button>
                           ))}
                        </ViewportPopoverRow>
                      </>
                    )}
                  </ViewportPopoverPanel>
                )}
              </ViewportPopoverTrigger> : null}

              {/* Topography */}
              {showTopographyControls && (
                <ViewportPopoverTrigger preferredHorizontal="left">
                  <ViewportIconAction
                    icon={<Mountain size={14} />}
                    showCaret
                    active={openPopover === "topo"}
                    onClick={() => setOpenPopover(prev => prev === "topo" ? null : "topo")}
                    title="Topography"
                  />
                  {openPopover === "topo" && (
                    <ViewportPopoverPanel anchorRef={{ current: null }} title="Topography">
                       <ViewportPopoverRow label="Enable">
                          <button className={toolbarOptionClassName} data-active={settings.topoEnabled} onClick={() => update({ topoEnabled: !settings.topoEnabled })}>
                            {settings.topoEnabled ? "ON" : "OFF"}
                          </button>
                       </ViewportPopoverRow>
                       {settings.topoEnabled && (
                         <>
                            <ViewportPopoverRow label="Display">
                              {(["x", "y", "z"] as TopoComponent[]).map(v => (
                                <button key={v} className={toolbarOptionClassName} data-active={settings.topoComponent === v} onClick={() => update({ topoComponent: v })}>
                                  m{v.toUpperCase()}
                                </button>
                              ))}
                            </ViewportPopoverRow>
                            <ViewportPopoverRow label="Amplitude">
                               <input type="range" className="flex-1 h-[3px] accent-primary max-w-[120px]" min={0.5} max={50} step={0.5} value={settings.topoMultiplier} onChange={(e) => update({ topoMultiplier: parseFloat(e.target.value) })} />
                            </ViewportPopoverRow>
                         </>
                       )}
                    </ViewportPopoverPanel>
                  )}
                </ViewportPopoverTrigger>
              )}

              {/* Camera Info */}
              {showCameraControls ? <ViewportPopoverTrigger preferredHorizontal="left">
                <ViewportIconAction
                  icon={<Video size={14} />}
                  showCaret
                  active={openPopover === "camera"}
                  onClick={() => setOpenPopover(prev => prev === "camera" ? null : "camera")}
                  title="Camera"
                />
                {openPopover === "camera" && (
                  <ViewportPopoverPanel anchorRef={{ current: null }} title="Camera Presets">
                    <div className="grid grid-cols-2 gap-1 px-1">
                      <button className="text-[0.65rem] font-semibold uppercase tracking-widest px-2 py-1.5 hover:bg-muted/50 rounded transition-colors text-muted-foreground hover:text-foreground text-left" onClick={() => { snapCamera([0, 1, 0], [0, 0, -1]); setOpenPopover(null); }}>Top</button>
                      <button className="text-[0.65rem] font-semibold uppercase tracking-widest px-2 py-1.5 hover:bg-muted/50 rounded transition-colors text-muted-foreground hover:text-foreground text-left" onClick={() => { snapCamera([0, 0, 1]); setOpenPopover(null); }}>Front</button>
                      <button className="text-[0.65rem] font-semibold uppercase tracking-widest px-2 py-1.5 hover:bg-muted/50 rounded transition-colors text-muted-foreground hover:text-foreground text-left" onClick={() => { snapCamera([1, 0, 0]); setOpenPopover(null); }}>Right</button>
                      <button className="text-[0.65rem] font-semibold uppercase tracking-widest px-2 py-1.5 hover:bg-muted/50 rounded transition-colors text-muted-foreground hover:text-foreground text-left" onClick={() => { snapCamera([1, 1, 1]); setOpenPopover(null); }}>Iso</button>
                      <button className="text-[0.65rem] font-semibold uppercase tracking-widest px-2 py-1.5 hover:bg-muted/50 rounded transition-colors text-muted-foreground hover:text-foreground text-left" onClick={() => { resetCamera(); setOpenPopover(null); }}>Reset</button>
                    </div>
                  </ViewportPopoverPanel>
                )}
              </ViewportPopoverTrigger> : null}

              {showRotationDebugControls ? <ViewportPopoverTrigger preferredHorizontal="left">
                <ViewportIconAction
                  icon={<RotateCw size={14} />}
                  label="R"
                  active={openPopover === "rotation"}
                  onClick={() => setOpenPopover(prev => prev === "rotation" ? null : "rotation")}
                  className="min-w-[34px]"
                  title="Rotation Debug"
                />
                {openPopover === "rotation" && (
                  <ViewportPopoverPanel
                    anchorRef={{ current: null }}
                    title="Rotation Debug"
                    className="min-w-[320px] max-w-[420px]"
                  >
                    <div className="space-y-2">
                      <div className="text-[0.62rem] text-muted-foreground">
                        Viewport, kostka i HSL raportują tu własne snapshoty orientacji po zmianie kamery.
                      </div>
                      <RotationDebugBlock label="Viewport 3D" snapshot={rotationSnapshots.viewport} />
                      <RotationDebugBlock label="ViewCube" snapshot={rotationSnapshots.viewCube} />
                      <RotationDebugBlock label="HSL Sphere" snapshot={rotationSnapshots.hsl} />
                    </div>
                  </ViewportPopoverPanel>
                )}
              </ViewportPopoverTrigger> : null}

              {showInfoControls ? <ViewportPopoverTrigger preferredHorizontal="left">
                <ViewportIconAction
                  icon={<Info size={14} />}
                  showCaret
                  active={openPopover === "info"}
                  onClick={() => setOpenPopover(prev => prev === "info" ? null : "info")}
                  title="Viewport Info"
                />
                {openPopover === "info" && (
                  <ViewportPopoverPanel
                    anchorRef={{ current: null }}
                    title="Viewport Info"
                    className="min-w-[260px] max-w-[360px]"
                  >
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[0.66rem]">
                      <span className="text-muted-foreground">Grid</span>
                      <span className="font-mono text-right">{nx} x {ny} x {nz}</span>
                      <span className="text-muted-foreground">Field</span>
                      <span className="font-mono text-right">{fieldLabel ?? "M"}</span>
                      <span className="text-muted-foreground">Render</span>
                      <span className="font-mono text-right">{settings.renderMode}</span>
                      <span className="text-muted-foreground">Quality</span>
                      <span className="font-mono text-right">{settings.quality}</span>
                      <span className="text-muted-foreground">Sampling</span>
                      <span className="font-mono text-right">{settings.sampling}x</span>
                      <span className="text-muted-foreground">Topography</span>
                      <span className="font-mono text-right">{settings.topoEnabled ? `on (${settings.topoComponent})` : "off"}</span>
                      <span className="text-muted-foreground">Visible</span>
                      <span className="font-mono text-right">{viewportVisible ? "yes" : "no"}</span>
                    </div>
                  </ViewportPopoverPanel>
                )}
              </ViewportPopoverTrigger> : null}

              {showSnapshotControl ? <ViewportToolSeparator /> : null}

              {/* Capture */}
              {showSnapshotControl ? (
                <ViewportIconAction
                  icon={<Camera size={14} />}
                  onClick={captureSnapshot}
                  title="Snapshot"
                />
              ) : null}
            </ViewportToolGroup> : null}
          </ViewportToolbar3D>
          ) : null}
        </ViewportOverlayLayout.TopLeft>

        <ViewportOverlayLayout.TopRight>
          {showViewCube && viewportVisible && (
            <ViewCube
              sceneRef={viewCubeSceneRef}
              onRotate={handleViewCubeRotate}
              onReset={resetCamera}
              axisConvention={VECTOR_SURFACE_AXIS_CONVENTION}
              onOrientationSnapshot={(snapshot) => updateRotationSnapshot("viewCube", snapshot)}
            />
          )}
        </ViewportOverlayLayout.TopRight>

        <ViewportOverlayLayout.BottomLeft>
          {showOrientationSphere ? (
            <HslSphere
              sceneRef={viewCubeSceneRef}
              axisConvention={VECTOR_SURFACE_AXIS_CONVENTION}
              size={156}
              visible={viewportVisible}
              onOrientationSnapshot={(snapshot) => updateRotationSnapshot("hsl", snapshot)}
            />
          ) : null}
        </ViewportOverlayLayout.BottomLeft>

        {(showFieldLegend || showLiveRenderDebugPanel) && (
        <ViewportOverlayLayout.BottomRight>
          {showFieldLegend ? (
            <div className="pointer-events-auto w-[min(18rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border/40 bg-background/86 shadow-md backdrop-blur-md">
              <div className="border-b border-border/25 px-3 py-2">
                <div className="text-[0.62rem] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                  Legend
                </div>
                <div className="mt-0.5 truncate text-[0.72rem] font-semibold text-foreground">
                  {fieldLabel ?? "Field"}
                </div>
              </div>
              <div className="space-y-2 px-3 py-2 text-[0.68rem]">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Mode</span>
                  <span className="font-mono text-foreground">{legendModeLabel}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full border border-border/30 bg-gradient-to-r from-[#2b6cb0] via-[#f6e05e] to-[#c53030]" />
                <div className="flex items-center justify-between font-mono text-[0.6rem] uppercase text-muted-foreground">
                  <span>-1</span>
                  <span>0</span>
                  <span>+1</span>
                </div>
              </div>
            </div>
          ) : null}
          {showLiveRenderDebugPanel ? (
            <div className="pointer-events-auto w-[min(28rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-emerald-400/35 bg-slate-950/86 shadow-[0_20px_45px_rgba(0,0,0,0.42)] backdrop-blur-md">
              <div className="border-b border-emerald-400/20 px-4 py-3">
                <div className="text-[0.65rem] font-bold uppercase tracking-[0.2em] text-emerald-300">
                  Live Render Debug
                </div>
                <div className="mt-1 text-[0.72rem] text-slate-200">
                  Fragment bufora przekazywanego do renderera 3D
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 px-4 py-3 text-[0.68rem]">
                <span className="text-slate-400">Field</span>
                <span className="font-mono text-right text-slate-100">{fieldLabel}</span>
                <span className="text-slate-400">Source</span>
                <span className="font-mono text-right text-slate-100">{liveRenderDebugData?.source ?? "none"}</span>
                <span className="text-slate-400">Step</span>
                <span className="font-mono text-right text-slate-100">{liveRenderDebugData?.effectiveStep ?? "-"}</span>
                <span className="text-slate-400">Vectors</span>
                <span className="font-mono text-right text-slate-100">{renderedVectorCount}</span>
                <span className="text-slate-400">Raw values</span>
                <span className="font-mono text-right text-slate-100">{deferredVectors?.length ?? 0}</span>
                <span className="text-slate-400">Updated</span>
                <span className="font-mono text-right text-slate-100">
                  {formatDebugTimestamp(liveRenderDebugData?.fieldDataTimestamp ?? null)}
                </span>
                <span className="text-slate-400">Live step</span>
                <span className="font-mono text-right text-slate-100">{liveRenderDebugData?.liveFieldSourceStep ?? "-"}</span>
                <span className="text-slate-400">Preview step</span>
                <span className="font-mono text-right text-slate-100">{liveRenderDebugData?.previewSourceStep ?? "-"}</span>
              </div>
              <div className="border-t border-emerald-400/12 px-4 py-3">
                <div className="mb-2 text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-slate-400">
                  Rendered buffer sample
                </div>
                <pre className="max-h-56 overflow-auto rounded-lg border border-white/8 bg-black/30 px-3 py-2 text-[0.68rem] leading-5 text-emerald-100">
{renderedVectorSample.length > 0
  ? renderedVectorSample.join("\n")
  : "Brak danych wektorowych przekazanych do renderera."}
                </pre>
                <div className="mt-2 text-[0.62rem] text-slate-500">
                  Revision: {liveRenderDebugData?.fieldDataRevision ?? "none"}
                </div>
              </div>
            </div>
          ) : null}
        </ViewportOverlayLayout.BottomRight>
        )}

        {/* ── 3dsmax-style interaction mode toolbar (only when texture gizmo available) ── */}
        {showTextureScopeToolbar && (activeTextureTransform || activeTransformScope === "texture") && (
          <ViewportOverlayLayout.BottomCenter>
            <div className="pointer-events-auto flex items-center gap-px rounded-lg border border-border/40 bg-background/80 backdrop-blur-md shadow-md px-1 py-1">
              {/* Scope Toggle */}
              {onTransformScopeChange && (
                <>
                  <button
                    type="button"
                    title="Close texture gizmo"
                    onClick={() => onTransformScopeChange(null)}
                    className="flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:bg-rose-500/20 hover:text-rose-400 transition-colors"
                  >
                    <Box size={13} />
                  </button>
                  <div className="w-px h-4 bg-border/50 mx-1" />
                </>
              )}

              {/* Orbit / Camera */}
              <button
                type="button"
                title="Orbit camera (Q)"
                onClick={() => setInteractionMode("camera")}
                className={cn(
                  "flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[0.65rem] font-bold uppercase tracking-wider transition-colors",
                  cameraActive
                    ? "bg-primary/20 text-primary border border-primary/35"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground border border-transparent",
                )}
              >
                <MousePointer2 size={13} />
                <span>Orbit</span>
                <span className="text-[0.55rem] opacity-50 font-normal normal-case tracking-normal">Q</span>
              </button>

              <div className="w-px h-4 bg-border/50 mx-0.5" />

              {/* Move */}
              <button
                type="button"
                title="Move texture (W)"
                onClick={() => setInteractionMode("move")}
                className={cn(
                  "flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[0.65rem] font-bold uppercase tracking-wider transition-colors",
                  interactionMode === "move"
                    ? "bg-amber-500/20 text-amber-400 border border-amber-500/35"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground border border-transparent",
                )}
              >
                <Move size={13} />
                <span>Move</span>
                <span className="text-[0.55rem] opacity-50 font-normal normal-case tracking-normal">W</span>
              </button>

              {/* Rotate */}
              <button
                type="button"
                title="Rotate texture (E)"
                onClick={() => setInteractionMode("rotate")}
                className={cn(
                  "flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[0.65rem] font-bold uppercase tracking-wider transition-colors",
                  interactionMode === "rotate"
                    ? "bg-amber-500/20 text-amber-400 border border-amber-500/35"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground border border-transparent",
                )}
              >
                <RotateCw size={13} />
                <span>Rotate</span>
                <span className="text-[0.55rem] opacity-50 font-normal normal-case tracking-normal">E</span>
              </button>

              {/* Scale */}
              <button
                type="button"
                title="Scale texture (R)"
                onClick={() => setInteractionMode("scale")}
                className={cn(
                  "flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[0.65rem] font-bold uppercase tracking-wider transition-colors",
                  interactionMode === "scale"
                    ? "bg-amber-500/20 text-amber-400 border border-amber-500/35"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground border border-transparent",
                )}
              >
                <Maximize2 size={13} />
                <span>Scale</span>
                <span className="text-[0.55rem] opacity-50 font-normal normal-case tracking-normal">R</span>
              </button>
            </div>
          </ViewportOverlayLayout.BottomCenter>
        )}
      </ViewportOverlayLayout>

      {/* ── R3F Canvas ────────────────────────────────────── */}
      <div ref={hostRef} className="absolute inset-0 pointer-events-none z-0">
        {!vectorSurfaceFlags.enableCanvas3D ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[0.72rem] text-muted-foreground">
            VectorSurface canvas disabled (`vectorSurfaceViewport.enableCanvas3D = false`)
          </div>
        ) : shouldRenderVectorSurfaceCanvas({
          canvasEnabled: vectorSurfaceFlags.enableCanvas3D,
          hostReady: Boolean(hostNode),
          viewportVisible,
        }) ? (
          <Canvas
            key={canvasContextGeneration}
            eventSource={hostNode ?? undefined}
            frameloop={frameloop}
            className="w-full h-full pointer-events-auto"
            camera={{
              fov: 50,
              near: 0.1,
              far: 1000,
              position: [
                cx + DEFAULT_CAMERA_DIRECTION[0] * orbitDist,
                cy + DEFAULT_CAMERA_DIRECTION[1] * orbitDist,
                cz + DEFAULT_CAMERA_DIRECTION[2] * orbitDist,
              ],
              up: DEFAULT_CAMERA_UP,
            }}
            gl={{
              antialias: settings.quality !== "low",
            }}
            onCreated={({ gl, scene, camera }) => {
              canvasContextCleanupRef.current?.();
              telemetry.recordLifecycleEvent("canvas_mount");
              incrementFrontendAuditCounter("webglCanvasMounted", 1);
              recordFrontendAuditWebGLContext("vector-surface-viewport", gl.getContext());
              canvasRef.current = gl.domElement;
              glRef.current = gl;
              r3fSceneRef.current = scene;
              r3fCameraRef.current = camera;
              const canvas = gl.domElement;
              canvas.addEventListener("webglcontextlost", handleContextLost, false);
              canvas.addEventListener("webglcontextrestored", handleContextRestored, false);
              canvasContextCleanupRef.current = () => {
                telemetry.recordLifecycleEvent("canvas_unmount");
                clearContextLossRetryTimer();
                canvas.removeEventListener("webglcontextlost", handleContextLost, false);
                canvas.removeEventListener("webglcontextrestored", handleContextRestored, false);
              };
              logVectorSurfaceDebug("canvas created", {
                key: cameraPersistenceKey,
                generation: canvasContextGeneration,
              });
            }}
            dpr={canvasDpr}
            style={{ background: `#${BG_COLOR.toString(16).padStart(6, "0")}` }}
          >
            <ViewportTelemetryProbe
              label="vector-surface-viewport"
              dpr={canvasDpr}
              hidden={!viewportVisible}
              onStats={telemetry.update}
            />
            <WarmRevealInvalidator visible={viewportVisible} />
            <color attach="background" args={[BG_COLOR]} />
            <SceneConfig toneMapping={settings.quality !== "low"} />

            <FdmLighting brightness={settings.brightness} quality={settings.quality} />

            {sceneMode === "grid" ? (
              <FdmInstances
                grid={deferredGrid}
                vectors={deferredVectors}
                geometryMode={geometryMode}
                activeMask={activeMask}
                settings={deferredSettings}
                sceneOpacityMultiplier={sceneOpacityMultiplier}
                isolateGridBounds={isolateGridBounds}
                vectorsVisible={vectorsVisible}
                onTopologyRebuild={recordFdmTopologyRebuild}
                onFieldBufferUpdate={recordFdmFieldBufferUpdate}
              />
            ) : null}

            {objectOverlays.length > 0 && (sceneMode === "world" || Boolean(worldExtent)) ? (
              <FdmObjectOverlayMeshes
                overlays={objectOverlays}
                selectedObjectId={selectedObjectId}
                objectViewMode={objectViewMode}
                sceneMode={sceneMode}
                grid={grid}
                worldExtent={worldExtent}
                universeCenter={universeCenter}
                onRequestObjectSelect={onRequestObjectSelect}
                onGeometryTranslate={onGeometryTranslate}
              />
            ) : null}

            {universeWireframeVisible && sceneMode === "world" ? (
              <FdmUniverseBounds worldExtent={worldExtent} universeCenter={universeCenter} />
            ) : null}

            {antennaOverlays.length > 0 && objectViewMode !== "isolate" && (sceneMode === "world" || Boolean(worldExtent)) ? (
              <FdmAntennaOverlayMeshes
                overlays={antennaOverlays}
                selectedAntennaId={selectedAntennaId}
                sceneMode={sceneMode}
                grid={grid}
                worldExtent={worldExtent}
                universeCenter={universeCenter}
                onAntennaTranslate={onAntennaTranslate}
              />
            ) : null}

            {axesWorldExtent && axesWorldExtent[0] > 0 && axesWorldExtent[1] > 0 && axesWorldExtent[2] > 0 && (
              <SceneAxes3D
                worldExtent={axesWorldExtent}
                center={axesCenter}
                sceneScale={axesSceneScale}
                axisLabels={axisLabelsForConvention(VECTOR_SURFACE_AXIS_CONVENTION)}
              />
            )}

            <SyncedControls
              controlsRefObject={controlsRef}
              viewCubeBridgeRef={viewCubeSceneRef}
              target={stableOrbitTarget}
              cameraEnabled={cameraActive && viewportVisible}
              onInteractionChange={handleCameraInteractionChange}
            />

            {activeTextureTransform && !cameraActive && (
              <TextureTransformGizmo
                transform={activeTextureTransform}
                mode={derivedGizmoMode}
                previewProxy={activeTexturePreviewProxy}
                showPreviewProxy
                syncPivotWithTranslation
                swapYZ
                onLiveChange={onTextureTransformChange}
                visible
                onCommit={onTextureTransformCommit}
              />
            )}

            {authoringOverlay}
          </Canvas>
        ) : null}
      </div>
    </div>
  );
}



export default memo(UnifiedVectorFieldRendererInner);
