"use client";

import type { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";
import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import type { PlanarMonitorFramePreview } from "@/kernel/workspace/planarMonitorFramePreview";
import type { DecodedFieldVector, DecodedTopology } from "@/kernel/api/codecs";
import {
  viewport3DAirboxLayerEnabledFromBrowserConfig,
  viewport3DBoundsLayersEnabledFromBrowserConfig,
  viewport3DCanvasLifecycleProbeEnabledFromBrowserConfig,
  viewport3DClipLayersEnabledFromBrowserConfig,
  viewport3DDimensionFrameEnabledFromBrowserConfig,
  viewport3DDimensionFrameLabelsEnabledFromBrowserConfig,
  viewport3DDimensionFrameLinesEnabledFromBrowserConfig,
  viewport3DDimensionFrameMajorLinesEnabledFromBrowserConfig,
  viewport3DDimensionFrameMinorLinesEnabledFromBrowserConfig,
  viewport3DFdmCuboidLayerEnabledFromBrowserConfig,
  viewport3DMeshSizeHighlightLayerEnabledFromBrowserConfig,
  viewport3DOverlayLayersEnabledFromBrowserConfig,
  viewport3DOrientationHudEnabledFromBrowserConfig,
  viewport3DPostProcessingEnabledFromBrowserConfig,
  viewport3DPrimitiveObjectLayerEnabledFromBrowserConfig,
  viewport3DSceneLayersEnabledFromBrowserConfig,
  viewport3DTopologyMeshLayerEnabledFromBrowserConfig,
} from "@/kernel/browserFullmagConfig";
import { OrthographicCamera, PerspectiveCamera } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  Raycaster,
  Vector3,
  Vector2,
  type OrthographicCamera as ThreeOrthographicCamera,
  type PerspectiveCamera as ThreePerspectiveCamera,
} from "three";

import type {
  VisualizationTargetRef,
  VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";
import type { PeriodicOverlayModel } from "@/shared/domain/mesh/periodicOverlayModel";

import type {
  FdmNativeLayerRenderView,
  FdmMultilayerAirboxRenderView,
  FdmGridRenderDomain,
  FemManifestRenderDomain,
  Viewport3DMeshPart,
  Viewport3DPartSelection,
} from "../viewport3dDomainAdapter";
import type { HysteresisReplayGlyphModel } from "../model/viewport3DTargets";
import type {
  Viewport3DInspectSample,
  Viewport3DInspectScreenPosition,
} from "../viewport3dInspect";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type {
  Viewport3DBounds,
  Viewport3DFieldRenderModel,
  Viewport3DTopologyRenderModel,
} from "../viewport3dRenderModel";
import type { Viewport3DMeshSizeHighlightModel } from "../viewport3dMeshSizeHighlight";
import type { ScalarColorBuffer } from "../viewport3dFieldMapping";
import type { Viewport3DTopologyFreshness } from "../viewport3dTopologyStaleness";
import type {
  Viewport3DMagnetizationTexturePreview,
  Viewport3DPrimitiveObject,
  Viewport3DPrimitiveRenderModel,
} from "../viewport3dPrimitiveModel";
import type {
  Viewport3DCameraProjection,
  Viewport3DCameraState,
  Viewport3DDimensionFrameDensity,
  Viewport3DDimensionFrameMode,
  Viewport3DRotationMode,
  Viewport3DScaleUnitMode,
} from "../viewport3dStore";
import { DEFAULT_VIEWPORT_3D_CAMERA_STATE } from "../viewport3dStore";
import type { Viewport3DColors } from "../viewport3dTypes";
import type { VectorFieldLayerVectorStyle } from "./VectorFieldLayer";
import { DimensionFrameLayer } from "./DimensionFrameLayer";
import { OrientationHudLayer } from "../orientation/OrientationHudLayer";
import {
  CameraController,
  OrbitCameraControls,
  VIEWPORT_3D_WORLD_UP,
  resolveViewport3DCameraFit,
  type Viewport3DCameraChange,
  type Viewport3DOrbitDebugAngles,
} from "./CameraControls";
import { CanvasLifecycleProbe } from "./CanvasLifecycleProbe";
import {
  AirboxLayer,
  DomainBoxLayer,
  FdmMultilayerAirboxBoundsLayer,
  FdmUniverseOutsideSupportLayer,
  SelectionHighlightLayer,
} from "./BoundsLayers";
import { TopologyMeshLayer } from "./TopologyMeshLayer";
import { MeshSizeHighlightLayer } from "./MeshSizeHighlightLayer";
import {
  RegionOverlayLayer,
  type RegionOverlaySelection,
} from "./RegionOverlayLayer";
import { RegionMeshOverlayLayer } from "./RegionMeshOverlayLayer";
import { PeriodicPairsOverlayLayer } from "./PeriodicPairsOverlayLayer";
import {
  useViewport3DRegionOverlayModels,
  type Viewport3DRegionOverlayBuildStatus,
} from "../region-overlays/useViewport3DRegionOverlayModels";
import { PostProcessingLayer } from "./PostProcessingLayer";
import { PrimitiveObjectLayer } from "./PrimitiveObjectLayer";
import { FdmCuboidLayer, type FdmCuboidInstanceModel } from "./FdmCuboidLayer";
import { VectorGlyphDerivedBufferCacheProvider } from "./vectorGlyphDerivedBufferRuntime";
import { HysteresisReplayGlyphLayer } from "./HysteresisReplayGlyphLayer";
import { Viewport3DLightingRig } from "./Viewport3DLightingRig";
import {
  ClipPlaneFramePreviewLayer,
  ClipPlaneLayer,
  PlanarMonitorFramePreviewLayer,
} from "./ClipPlaneLayer";
import { pickRegionOverlayFromRay } from "./regionOverlayPicking";
import type { ClipPlaneIntersectionMarkerBuffers } from "./clipPlaneModel";
import {
  buildRegionOverlayModels,
  type RegionMeshOverlayOwnerPart,
  type RegionOverlayInput,
} from "./regionOverlayModel";
import {
  regionOverlayModeShowsAuthored,
  regionOverlayModeShowsRealized,
  type RegionOverlayMode,
} from "../regionOverlayMode";
import {
  getViewport3DVisualProfile,
  type Viewport3DVisualProfileId,
} from "../viewport3dVisualProfile";
import { resolveViewport3DMaterialProfile } from "./viewport3DMaterialProfile";
import { clampNumber, sameTuple3 } from "../viewport3dMath";
import { createViewport3DCameraGestureRef } from "./viewport3DCameraGesture";
import type { Viewport3DRenderAdoptionRegistry } from "../model/viewport3DRenderAdoptionRegistry";
import type { FdmUniverseOutsideSupportOverlayModel } from "../model/fdmUniverseOverlay";
import type { Viewport3DFdmTargetRenderView } from "../model/viewport3DFdmTargetViews";
import type { FdmAirboxPassPlan } from "./fdmAirboxPassPlan";
import type { Viewport3DVectorBuildReference } from "../viewport3dRenderModel";

interface Viewport3DSceneProps {
  adoptionRegistry?: Viewport3DRenderAdoptionRegistry;
  bounds: Viewport3DBounds | null;
  cameraOrthographicScale: number | null;
  cameraProjection: Viewport3DCameraProjection;
  cameraState: Viewport3DCameraState;
  colors: Viewport3DColors;
  clip: VisualizationStateResource["clip"] | null;
  clipFrameRotationDegrees: number;
  clipIntersectionMarkers: ClipPlaneIntersectionMarkerBuffers | null;
  crossSectionFrameClip: VisualizationStateResource["clip"] | null;
  crossSectionFrameRotationDegrees: number;
  planarMonitorFramePreview: PlanarMonitorFramePreview | null;
  dimensionFrameDensity: Viewport3DDimensionFrameDensity;
  dimensionFrameMode: Viewport3DDimensionFrameMode;
  fdmLaneActive: boolean;
  airboxSettings: VisualizationTargetSettings;
  fdmDomain: FdmGridRenderDomain | null;
  fdmAirboxInstanceModel: FdmCuboidInstanceModel | null | undefined;
  fdmAirboxPassPlan: FdmAirboxPassPlan;
  fdmAirboxFieldVector: DecodedFieldVector | null | undefined;
  fdmAirboxVectorGlyphColors: ScalarColorBuffer | null;
  fdmAirboxVectorBuildReference: Viewport3DVectorBuildReference | null;
  fdmAirboxVectorSegments: Float32Array | null;
  fdmMultilayerAirboxView: FdmMultilayerAirboxRenderView | null;
  fdmUniverseOutsideSupport: FdmUniverseOutsideSupportOverlayModel | null;
  fdmUniverseOutsideSupportSettings: VisualizationTargetSettings | null;
  fdmInstanceModel: FdmCuboidInstanceModel | null | undefined;
  availableQuantityIds?: ReadonlySet<string> | null;
  fdmNativeLayerViews: readonly FdmNativeLayerRenderView[];
  fdmTargetViews: readonly Viewport3DFdmTargetRenderView[];
  fdmSettings: VisualizationTargetSettings;
  fdmSurfaceColors: ScalarColorBuffer | null;
  fdmVectorColors: ScalarColorBuffer | null;
  fdmVectorGlyphColors: ScalarColorBuffer | null;
  fdmVectorSegments: Float32Array | null;
  femDomain: FemManifestRenderDomain;
  fieldModel: Viewport3DFieldRenderModel | null;
  hysteresisReplayGlyphModel: HysteresisReplayGlyphModel | null;
  fitRevision: number;
  getObjectSettings: (
    object: Viewport3DPrimitiveObject,
  ) => VisualizationTargetSettings;
  getPartSettings: (part: Viewport3DMeshPart) => VisualizationTargetSettings;
  magnetizationTexturePreviews: Map<
    string,
    Viewport3DMagnetizationTexturePreview
  >;
  maxVectorGlyphs: number;
  meshQualityColors: ScalarColorBuffer | null;
  meshQualityOverlayVisible: boolean;
  meshRegionOverlayParts: readonly RegionMeshOverlayOwnerPart[];
  meshRegionOverlays: readonly RegionOverlayInput[];
  periodicOverlayModel: PeriodicOverlayModel | null;
  meshSizeHighlightModel: Viewport3DMeshSizeHighlightModel | null;
  onCameraChange: (
    camera: Viewport3DCameraChange,
    epoch?: number,
  ) => Promise<void> | void;
  onCameraInteractionEnd?: (epoch?: number) => void;
  onCameraInteractionStart?: (epoch?: number) => void;
  onOrbitDebugAnglesChange?: (angles: Viewport3DOrbitDebugAngles) => void;
  onVisualizationFrameCommitted: (revision: number) => void;
  onSelectObject: (object: Viewport3DPrimitiveObject) => void;
  onSelectRegion: (selection: RegionOverlaySelection) => void;
  onSelectDomain: () => void;
  onSelectFdmTarget: (target: VisualizationTargetRef) => void;
  onSelectFdmUniverseOutsideSupport: () => void;
  onSelectFdmCell?: (instanceId: number) => void;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  orbitDebugAngles: Viewport3DOrbitDebugAngles;
  orbitDebugCommitRevision: number;
  orbitDebugRevision: number;
  fallbackSettings: VisualizationTargetSettings;
  primitiveModel: Viewport3DPrimitiveRenderModel | null;
  resetCameraRevision: number;
  requestDiagnostics: RequestDiagnosticsController;
  resourceFrameKey: string;
  regionOverlayMode: RegionOverlayMode;
  regionOverlays: readonly RegionOverlayInput[];
  rotationMode: Viewport3DRotationMode;
  selectionBounds: Viewport3DBounds | null;
  selectedObjectId: string | null;
  selectedRegionId: string | null;
  tracker: Viewport3DResourceTracker;
  topologyFreshness: Viewport3DTopologyFreshness;
  topology: DecodedTopology | null | undefined;
  topologyModel: Viewport3DTopologyRenderModel<Viewport3DMeshPart> | null;
  topologyRevision: number | string | null;
  vectorColorMode: string;
  vectorScale: number;
  vectorStyle: VectorFieldLayerVectorStyle;
  visualizationRevision: number | null;
  hslReferenceVisible: boolean;
  inspectEnabled: boolean;
  onInspectClear?: () => void;
  onInspectSample?: (
    sample: Viewport3DInspectSample,
    screenPosition: Viewport3DInspectScreenPosition,
  ) => void;
  scaleLabelsVisible: boolean;
  scaleUnitMode: Viewport3DScaleUnitMode;
  viewCubeVisible: boolean;
  visualProfileId: Viewport3DVisualProfileId;
}

interface Viewport3DViewportSize {
  height: number;
  width: number;
}

interface Viewport3DOrthographicCameraFrame {
  bottom: number;
  left: number;
  right: number;
  top: number;
  zoom: number;
}

interface Viewport3DCameraClip {
  far: number;
  near: number;
}

type Viewport3DProjectionCamera =
  | ThreeOrthographicCamera
  | ThreePerspectiveCamera;

export function shouldApplyViewport3DProjectionCameraClip({
  camera,
  clip,
  previous,
}: {
  camera: Viewport3DProjectionCamera;
  clip: Viewport3DCameraClip;
  previous: {
    camera: Viewport3DProjectionCamera;
    clip: Viewport3DCameraClip;
  } | null;
}): boolean {
  return Boolean(
    !previous ||
      previous.camera !== camera ||
      previous.clip.near !== clip.near ||
      previous.clip.far !== clip.far,
  );
}

const FALLBACK_GRID_SIZE = 1e-6;
const PERSPECTIVE_CAMERA_FOV_DEGREES = 42;

/**
 * Resolve the initial scene camera against the actual domain bounds.
 *
 * The persisted default camera is FEM-sized (micrometre scale). FDM domains
 * are commonly nanometre-scale, so handing that default directly to the
 * active Three camera leaves the structured grid effectively invisible. A
 * real user camera remains authoritative; only the untouched application
 * default is replaced by the bounds fit.
 */
export function resolveViewport3DEffectiveCameraState({
  bounds,
  cameraState,
}: {
  bounds: Viewport3DBounds | null;
  cameraState: Viewport3DCameraState;
}): Viewport3DCameraState {
  if (
    !bounds ||
    !sameTuple3(cameraState.position, DEFAULT_VIEWPORT_3D_CAMERA_STATE.position) ||
    !sameTuple3(cameraState.target, DEFAULT_VIEWPORT_3D_CAMERA_STATE.target)
  ) {
    return cameraState;
  }

  const fit = resolveViewport3DCameraFit(bounds);
  return {
    position: fit.position,
    target: fit.target,
    up: VIEWPORT_3D_WORLD_UP,
  };
}

export function resolveViewport3DProjectionCameraClip(
  bounds: Viewport3DBounds | null,
  cameraState?: Viewport3DCameraState,
): Viewport3DCameraClip {
  const fit = resolveViewport3DCameraFit(bounds);
  if (!cameraState) return { near: fit.near, far: fit.far };

  const distance = new Vector3(...cameraState.position).distanceTo(
    new Vector3(...cameraState.target),
  );
  const radius = Math.max(bounds?.radius ?? FALLBACK_GRID_SIZE / 2, 1e-12);
  const orbitFar =
    Number.isFinite(distance) && distance > 0
      ? distance + radius * 4
      : fit.far;

  return {
    near: fit.near,
    far: Math.max(fit.far, orbitFar, fit.near * 100, 1e-3),
  };
}

export function resolveViewport3DOrthographicZoom(
  bounds: Viewport3DBounds | null,
  viewportSize: Viewport3DViewportSize,
  cameraState?: Viewport3DCameraState,
  orthographicScale?: number | null,
): number {
  const width = Math.max(2, viewportSize.width);
  const height = Math.max(2, viewportSize.height);
  if (
    typeof orthographicScale === "number" &&
    Number.isFinite(orthographicScale) &&
    orthographicScale > 0
  ) {
    return clampNumber(height / orthographicScale, 1e-3, 1e12);
  }

  const fitSize = resolveViewport3DOrthographicFitSize(bounds, cameraState);
  return clampNumber(
    Math.min(width / (fitSize.width * 1.6), height / (fitSize.height * 1.6)),
    1e-3,
    1e12,
  );
}

export function resolveViewport3DOrthographicCameraFrame(
  bounds: Viewport3DBounds | null,
  viewportSize: Viewport3DViewportSize,
  cameraState?: Viewport3DCameraState,
  orthographicScale?: number | null,
): Viewport3DOrthographicCameraFrame {
  const width = Math.max(2, viewportSize.width);
  const height = Math.max(2, viewportSize.height);

  return {
    bottom: -height / 2,
    left: -width / 2,
    right: width / 2,
    top: height / 2,
    zoom: resolveViewport3DOrthographicZoom(
      bounds,
      { height, width },
      cameraState,
      orthographicScale,
    ),
  };
}

function resolveViewport3DOrthographicFitSize(
  bounds: Viewport3DBounds | null,
  cameraState: Viewport3DCameraState | undefined,
): { height: number; width: number } {
  const fallbackSpan = bounds
    ? Math.max(...bounds.size, bounds.radius * 2, 1e-12)
    : FALLBACK_GRID_SIZE;
  if (!bounds || !cameraState) {
    return { height: fallbackSpan, width: fallbackSpan };
  }

  const basis = resolveViewport3DOrthographicBasis(cameraState);
  if (!basis) {
    return { height: fallbackSpan, width: fallbackSpan };
  }

  const target = new Vector3(...cameraState.target);
  const halfSize = bounds.size.map((value) => Math.max(0, value) / 2) as [
    number,
    number,
    number,
  ];
  let maxX = 0;
  let maxY = 0;

  for (const xSign of [-1, 1]) {
    for (const ySign of [-1, 1]) {
      for (const zSign of [-1, 1]) {
        const corner = new Vector3(
          bounds.center[0] + halfSize[0] * xSign,
          bounds.center[1] + halfSize[1] * ySign,
          bounds.center[2] + halfSize[2] * zSign,
        ).sub(target);
        maxX = Math.max(maxX, Math.abs(corner.dot(basis.right)));
        maxY = Math.max(maxY, Math.abs(corner.dot(basis.up)));
      }
    }
  }

  return {
    height: Math.max(maxY * 2, 1e-12),
    width: Math.max(maxX * 2, 1e-12),
  };
}

function resolveViewport3DOrthographicBasis(
  cameraState: Viewport3DCameraState,
): { right: Vector3; up: Vector3 } | null {
  const forward = new Vector3(...cameraState.target).sub(
    new Vector3(...cameraState.position),
  );
  if (forward.lengthSq() <= 0) return null;
  forward.normalize();

  const rawUp = new Vector3(...cameraState.up);
  if (rawUp.lengthSq() <= 0) return null;
  rawUp.normalize();

  const right = new Vector3().crossVectors(forward, rawUp);
  if (right.lengthSq() <= 0) return null;
  right.normalize();

  const up = new Vector3().crossVectors(right, forward);
  if (up.lengthSq() <= 0) return null;
  up.normalize();

  return { right, up };
}

export function applyViewport3DPerspectiveCameraPose(
  camera: ThreePerspectiveCamera,
  cameraState: Viewport3DCameraState,
  near: number,
  far: number,
  fov: number,
): void {
  camera.up.set(...cameraState.up);
  camera.position.set(...cameraState.position);
  camera.lookAt(...cameraState.target);
  camera.near = near;
  camera.far = far;
  camera.fov = fov;
  camera.updateProjectionMatrix();
  camera.updateMatrix();
  camera.updateMatrixWorld();
}

export function applyViewport3DOrthographicCameraPose(
  camera: ThreeOrthographicCamera,
  cameraState: Viewport3DCameraState,
  near: number,
  far: number,
): void {
  camera.up.set(...cameraState.up);
  camera.position.set(...cameraState.position);
  camera.lookAt(...cameraState.target);
  camera.near = near;
  camera.far = far;
  camera.updateProjectionMatrix();
  camera.updateMatrix();
  camera.updateMatrixWorld();
}

export function scheduleViewport3DProjectionRenderFrames({
  frameHost = typeof window === "undefined" ? null : window,
  invalidate,
  tracker,
}: {
  frameHost?:
    | Pick<Window, "cancelAnimationFrame" | "requestAnimationFrame">
    | null;
  invalidate: () => void;
  tracker: Pick<Viewport3DResourceTracker, "recordDirtyFrame">;
}): () => void {
  tracker.recordDirtyFrame("camera-projection");
  invalidate();

  if (!frameHost) return () => undefined;

  const frameId = frameHost.requestAnimationFrame(() => {
    tracker.recordDirtyFrame("camera-projection-followup");
    invalidate();
  });

  return () => frameHost.cancelAnimationFrame(frameId);
}

export const VIEWPORT_3D_MODEL_LAYER_FINAL_STAGE = 3;

export interface Viewport3DModelLayerStageVisibility {
  authoredRegionOverlays: boolean;
  baseGeometry: boolean;
  fieldDrivenLayers: boolean;
  hysteresisReplayGlyphs: boolean;
  meshSizeHighlight: boolean;
  primitiveObjects: boolean;
  realizedRegionOverlays: boolean;
}

export function resolveNextViewport3DModelLayerStage(stage: number): number {
  return Math.min(
    Math.max(0, Math.floor(stage)) + 1,
    VIEWPORT_3D_MODEL_LAYER_FINAL_STAGE,
  );
}

export function resolveViewport3DModelLayerStageVisibility(
  stage: number,
): Viewport3DModelLayerStageVisibility {
  const safeStage = Math.max(0, Math.floor(stage));
  const baseGeometry = safeStage >= 1;
  const fieldDrivenLayers = safeStage >= 2;
  const finalLayers = safeStage >= VIEWPORT_3D_MODEL_LAYER_FINAL_STAGE;
  return {
    authoredRegionOverlays: finalLayers,
    baseGeometry,
    fieldDrivenLayers,
    hysteresisReplayGlyphs: finalLayers,
    meshSizeHighlight: finalLayers,
    primitiveObjects: true,
    realizedRegionOverlays: finalLayers,
  };
}

export interface Viewport3DAuthoredRegionOverlayVisibilityInput {
  readonly hasMeshBackedRegionOverlays: boolean;
  readonly overlayLayersEnabled: boolean;
  readonly realizedBuildStatus: Viewport3DRegionOverlayBuildStatus;
  readonly regionOverlayMode: RegionOverlayMode;
  readonly stageVisible: boolean;
}

export function resolveAuthoredRegionOverlayVisibility({
  hasMeshBackedRegionOverlays,
  overlayLayersEnabled,
  realizedBuildStatus,
  regionOverlayMode,
  stageVisible,
}: Viewport3DAuthoredRegionOverlayVisibilityInput): boolean {
  if (!stageVisible || !overlayLayersEnabled) return false;
  if (
    regionOverlayModeShowsAuthored(
      regionOverlayMode,
      hasMeshBackedRegionOverlays,
    )
  ) {
    return true;
  }
  return (
    regionOverlayMode === "auto" &&
    hasMeshBackedRegionOverlays &&
    (realizedBuildStatus === "pending" ||
      realizedBuildStatus === "stale-visible")
  );
}

function resolveViewport3DModelLayerStageKey({
  fdmAirboxInstanceModel,
  fdmMultilayerAirboxView,
  fdmNativeLayerViews,
  fdmTargetViews,
  primitiveModel,
  topologyModel,
}: Pick<
  Viewport3DSceneProps,
  | "fdmAirboxInstanceModel"
  | "fdmMultilayerAirboxView"
  | "fdmNativeLayerViews"
  | "fdmTargetViews"
  | "primitiveModel"
  | "topologyModel"
>): string {
  return [
    topologyModel?.meshGenerationId ?? "no-mesh-generation",
    topologyModel?.meshRevision ?? "no-mesh-revision",
    topologyModel?.nodeCount ?? 0,
    topologyModel?.magneticParts.length ?? 0,
    topologyModel?.airboxParts.length ?? 0,
    primitiveModel?.sceneRevision ?? "no-scene-revision",
    primitiveModel?.objects.length ?? 0,
    fdmAirboxInstanceModel ? "fdm-airbox-ready" : "fdm-airbox-empty",
    fdmMultilayerAirboxView?.model
      ? "fdm-multilayer-airbox-ready"
      : "fdm-multilayer-airbox-empty",
    fdmNativeLayerViews.length > 0 ? "fdm-native-ready" : "fdm-native-empty",
    fdmTargetViews.length > 0 ? "fdm-ready" : "fdm-empty",
  ].join(":");
}

function useViewport3DModelLayerStage({
  resetKey,
  tracker,
}: {
  resetKey: string;
  tracker: Viewport3DResourceTracker;
}): number {
  const invalidate = useThree((state) => state.invalidate);
  const [stageState, setStageState] = useState(() => ({
    resetKey,
    stage: 0,
  }));
  const stage = stageState.resetKey === resetKey ? stageState.stage : 0;

  useEffect(() => {
    tracker.recordDirtyFrame("model-layer-stage-reset");
    invalidate();
  }, [invalidate, resetKey, tracker]);

  useEffect(() => {
    if (stage >= VIEWPORT_3D_MODEL_LAYER_FINAL_STAGE) return undefined;
    if (typeof window === "undefined") return undefined;

    let cancelled = false;
    // idle-audit-allow-one-shot-raf: mount the next model-layer stage after the current demand frame.
    const frameId = window.requestAnimationFrame(() => {
      if (cancelled) return;
      tracker.recordDirtyFrame("model-layer-stage");
      setStageState((current) => {
        const currentStage =
          current.resetKey === resetKey ? current.stage : 0;
        return {
          resetKey,
          stage: resolveNextViewport3DModelLayerStage(currentStage),
        };
      });
      invalidate();
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
    };
  }, [invalidate, resetKey, stage, tracker]);

  return stage;
}

function Viewport3DProjectionStack({
  bounds,
  cameraClip,
  cameraGestureRef,
  cameraState,
  fitRevision,
  onCameraChange,
  orthographicCameraFrame,
  orthographicCameraRef,
  perspectiveCameraRef,
  resetCameraRevision,
  tracker,
}: Pick<
  Viewport3DSceneProps,
  | "bounds"
  | "cameraState"
  | "fitRevision"
  | "onCameraChange"
  | "resetCameraRevision"
  | "tracker"
> & {
  cameraClip: Viewport3DCameraClip;
  cameraGestureRef: ReturnType<typeof createViewport3DCameraGestureRef>;
  orthographicCameraFrame: Viewport3DOrthographicCameraFrame;
  orthographicCameraRef: RefObject<ThreeOrthographicCamera | null>;
  perspectiveCameraRef: RefObject<ThreePerspectiveCamera | null>;
}) {
  return (
    <>
      <OrthographicCamera
        key="viewport-3d-orthographic-camera"
        ref={orthographicCameraRef}
        bottom={orthographicCameraFrame.bottom}
        left={orthographicCameraFrame.left}
        near={cameraClip.near}
        far={cameraClip.far}
        right={orthographicCameraFrame.right}
        top={orthographicCameraFrame.top}
        up={VIEWPORT_3D_WORLD_UP}
        zoom={orthographicCameraFrame.zoom}
      />
      <PerspectiveCamera
        key="viewport-3d-perspective-camera"
        ref={perspectiveCameraRef}
        far={cameraClip.far}
        fov={PERSPECTIVE_CAMERA_FOV_DEGREES}
        near={cameraClip.near}
        up={VIEWPORT_3D_WORLD_UP}
      />
      <CameraController
        bounds={bounds}
        cameraGestureRef={cameraGestureRef}
        cameraState={cameraState}
        fitRevision={fitRevision}
        onCameraChange={onCameraChange}
        resetCameraRevision={resetCameraRevision}
        tracker={tracker}
      />
    </>
  );
}

function Viewport3DOverlayLayerStack({
  bounds,
  cameraProjection,
  cameraState,
  clip,
  clipFrameRotationDegrees,
  clipIntersectionMarkers,
  colors,
  crossSectionFrameClip,
  crossSectionFrameRotationDegrees,
  planarMonitorFramePreview,
  dimensionFrameDensity,
  dimensionFrameMode,
  fdmAirboxPassPlan,
  fdmDomain,
  fdmMultilayerAirboxView,
  fdmUniverseOutsideSupport,
  fdmUniverseOutsideSupportSettings,
  fdmSettings,
  materialProfile,
  onSelectDomain,
  onSelectFdmTarget,
  onSelectFdmUniverseOutsideSupport,
  scaleLabelsVisible,
  scaleUnitMode,
  selectionBounds,
  tracker,
}: Pick<
  Viewport3DSceneProps,
  | "bounds"
  | "cameraProjection"
  | "cameraState"
  | "clip"
  | "clipFrameRotationDegrees"
  | "clipIntersectionMarkers"
  | "colors"
  | "crossSectionFrameClip"
  | "crossSectionFrameRotationDegrees"
  | "planarMonitorFramePreview"
  | "dimensionFrameDensity"
  | "dimensionFrameMode"
  | "fdmAirboxPassPlan"
  | "fdmDomain"
  | "fdmMultilayerAirboxView"
  | "fdmUniverseOutsideSupport"
  | "fdmUniverseOutsideSupportSettings"
  | "fdmSettings"
  | "onSelectDomain"
  | "onSelectFdmTarget"
  | "onSelectFdmUniverseOutsideSupport"
  | "scaleLabelsVisible"
  | "scaleUnitMode"
  | "selectionBounds"
  | "tracker"
> & {
  materialProfile: ReturnType<typeof resolveViewport3DMaterialProfile>;
}) {
  if (!viewport3DOverlayLayersEnabledFromBrowserConfig()) return null;

  return (
    <>
      {viewport3DClipLayersEnabledFromBrowserConfig() && clip?.enabled ? (
        <ClipPlaneLayer
          bounds={bounds}
          clip={clip}
          frameRotationDegrees={clipFrameRotationDegrees}
          intersectionMarkers={clipIntersectionMarkers}
          colors={colors}
          tracker={tracker}
        />
      ) : null}
      {viewport3DClipLayersEnabledFromBrowserConfig() &&
      crossSectionFrameClip?.enabled &&
      !clip?.enabled &&
      !planarMonitorFramePreview ? (
        <ClipPlaneFramePreviewLayer
          bounds={bounds}
          clip={crossSectionFrameClip}
          colors={colors}
          frameRotationDegrees={crossSectionFrameRotationDegrees}
          tracker={tracker}
        />
      ) : null}
      {viewport3DClipLayersEnabledFromBrowserConfig() &&
      planarMonitorFramePreview &&
      !clip?.enabled ? (
        <PlanarMonitorFramePreviewLayer
          colors={colors}
          preview={planarMonitorFramePreview}
          tracker={tracker}
        />
      ) : null}
      {viewport3DBoundsLayersEnabledFromBrowserConfig() ? (
        <>
          <DomainBoxLayer
            bounds={
              fdmUniverseOutsideSupport?.magneticSupportBounds ??
              fdmDomain?.bounds ??
              bounds
            }
            boundsOpacityPercent={fdmSettings.boundsOpacityPercent}
            boundsVisible={fdmSettings.boundsVisible}
            colors={colors}
            onSelectDomain={onSelectDomain}
          />
          <FdmUniverseOutsideSupportLayer
            colors={colors}
            model={
              fdmAirboxPassPlan.needsExtentOverlay
                ? fdmUniverseOutsideSupport
                : null
            }
            onSelect={onSelectFdmUniverseOutsideSupport}
            settings={fdmUniverseOutsideSupportSettings}
            tracker={tracker}
          />
          <FdmMultilayerAirboxBoundsLayer
            colors={colors}
            onSelect={() => {
              if (fdmMultilayerAirboxView) {
                onSelectFdmTarget(fdmMultilayerAirboxView.target);
              }
            }}
            tracker={tracker}
            view={fdmMultilayerAirboxView}
          />
          <SelectionHighlightLayer
            bounds={selectionBounds}
            colors={colors}
            materialProfile={materialProfile}
          />
        </>
      ) : null}
      {viewport3DDimensionFrameEnabledFromBrowserConfig() ? (
        <DimensionFrameLayer
          bounds={bounds}
          cameraProjection={cameraProjection}
          cameraState={cameraState}
          colors={colors}
          density={dimensionFrameDensity}
          labelsVisible={
            scaleLabelsVisible &&
            viewport3DDimensionFrameLabelsEnabledFromBrowserConfig()
          }
          majorLinesVisible={
            viewport3DDimensionFrameLinesEnabledFromBrowserConfig() &&
            viewport3DDimensionFrameMajorLinesEnabledFromBrowserConfig()
          }
          materialProfile={materialProfile}
          mode={dimensionFrameMode}
          minorLinesVisible={
            viewport3DDimensionFrameLinesEnabledFromBrowserConfig() &&
            viewport3DDimensionFrameMinorLinesEnabledFromBrowserConfig()
          }
          tracker={tracker}
          unitMode={scaleUnitMode}
        />
      ) : null}
    </>
  );
}

function Viewport3DModelLayerStack({
  adoptionRegistry,
  airboxSettings,
  bounds,
  colors,
  fdmAirboxPassPlan,
  fdmAirboxFieldVector,
  fdmAirboxInstanceModel,
  fdmAirboxVectorGlyphColors,
  fdmAirboxVectorBuildReference,
  fdmAirboxVectorSegments,
  fdmMultilayerAirboxView,
  fdmLaneActive,
  fdmUniverseOutsideSupportSettings,
  fdmNativeLayerViews,
  fdmTargetViews,
  fieldModel,
  hysteresisReplayGlyphModel,
  getObjectSettings,
  getPartSettings,
  inspectEnabled,
  magnetizationTexturePreviews,
  materialProfile,
  meshQualityColors,
  meshQualityOverlayVisible,
  meshRegionOverlayParts,
  meshRegionOverlays,
  periodicOverlayModel,
  meshSizeHighlightModel,
  onInspectClear,
  onInspectSample,
  onSelectDomain,
  onSelectFdmTarget,
  onSelectFdmUniverseOutsideSupport,
  onSelectFdmCell,
  onSelectObject,
  onSelectPart,
  onSelectRegion,
  primitiveModel,
  regionOverlayMode,
  regionOverlays,
  selectedObjectId,
  selectedRegionId,
  topologyFreshness,
  topology,
  topologyModel,
  topologyRevision,
  tracker,
  vectorColorMode,
  vectorStyle,
  visualizationRevision,
}: Pick<
  Viewport3DSceneProps,
  | "adoptionRegistry"
  | "airboxSettings"
  | "bounds"
  | "colors"
  | "fdmAirboxPassPlan"
  | "fdmAirboxFieldVector"
  | "fdmAirboxInstanceModel"
  | "fdmAirboxVectorGlyphColors"
  | "fdmAirboxVectorBuildReference"
  | "fdmAirboxVectorSegments"
  | "fdmMultilayerAirboxView"
  | "fdmLaneActive"
  | "fdmUniverseOutsideSupportSettings"
  | "fdmNativeLayerViews"
  | "fdmTargetViews"
  | "fieldModel"
  | "getObjectSettings"
  | "getPartSettings"
  | "hysteresisReplayGlyphModel"
  | "magnetizationTexturePreviews"
  | "meshQualityColors"
  | "meshQualityOverlayVisible"
  | "meshRegionOverlayParts"
  | "meshRegionOverlays"
  | "periodicOverlayModel"
  | "meshSizeHighlightModel"
  | "inspectEnabled"
  | "onInspectClear"
  | "onInspectSample"
  | "onSelectDomain"
  | "onSelectFdmTarget"
  | "onSelectFdmUniverseOutsideSupport"
  | "onSelectFdmCell"
  | "onSelectObject"
  | "onSelectPart"
  | "onSelectRegion"
  | "primitiveModel"
  | "regionOverlayMode"
  | "regionOverlays"
  | "selectedObjectId"
  | "selectedRegionId"
  | "topology"
  | "topologyFreshness"
  | "topologyModel"
  | "topologyRevision"
  | "tracker"
  | "vectorColorMode"
  | "vectorStyle"
  | "visualizationRevision"
> & {
  materialProfile: ReturnType<typeof resolveViewport3DMaterialProfile>;
}) {
  const modelLayerStageKey = useMemo(
    () =>
      resolveViewport3DModelLayerStageKey({
        fdmAirboxInstanceModel,
        fdmMultilayerAirboxView,
        fdmNativeLayerViews,
        fdmTargetViews,
        primitiveModel,
        topologyModel,
      }),
    [
      fdmAirboxInstanceModel,
      fdmMultilayerAirboxView,
      fdmNativeLayerViews,
      fdmTargetViews,
      primitiveModel,
      topologyModel,
    ],
  );
  const modelLayerStage = useViewport3DModelLayerStage({
    resetKey: modelLayerStageKey,
    tracker,
  });
  const stageVisibility =
    resolveViewport3DModelLayerStageVisibility(modelLayerStage);
  const hasMeshBackedRegionOverlays = meshRegionOverlays.length > 0;
  const overlayLayersEnabled = viewport3DOverlayLayersEnabledFromBrowserConfig();
  const realizedRegionOverlaysVisible =
    regionOverlayModeShowsRealized(
      regionOverlayMode,
      hasMeshBackedRegionOverlays,
    ) &&
    stageVisibility.realizedRegionOverlays &&
    overlayLayersEnabled;
  const realizedRegionOverlayModels = useViewport3DRegionOverlayModels({
    enabled: realizedRegionOverlaysVisible,
    magneticParts: meshRegionOverlayParts,
    regions: meshRegionOverlays,
    selectedObjectId,
    selectedRegionId,
    topology,
    topologyRevision,
  });
  const realizedRegionOverlayBuildStatus = realizedRegionOverlaysVisible
    ? realizedRegionOverlayModels.status
    : "disabled";

  const realizedFdmObjectIds = useMemo(
    () =>
      new Set(
        fdmTargetViews.flatMap((view) =>
          view.ownerTarget.kind === "object" && view.ownerTarget.id.startsWith("object:")
            ? [view.ownerTarget.id.slice("object:".length)]
            : [],
        ),
      ),
    [fdmTargetViews],
  );

  if (!viewport3DSceneLayersEnabledFromBrowserConfig()) return null;

  const authoredRegionOverlaysVisible = resolveAuthoredRegionOverlayVisibility({
    hasMeshBackedRegionOverlays,
    overlayLayersEnabled,
    realizedBuildStatus: realizedRegionOverlayBuildStatus,
    regionOverlayMode,
    stageVisible: stageVisibility.authoredRegionOverlays,
  });
  const stagedFieldModel = stageVisibility.fieldDrivenLayers ? fieldModel : null;
  const stagedFdmTargetViews = stageVisibility.fieldDrivenLayers
    ? fdmTargetViews
    : fdmTargetViews.map((view) => ({
        ...view,
        fieldVector: null,
        surfaceColors: null,
        vectorColors: null,
        vectorGlyphColors: null,
        vectorSegments: null,
      }));
  const stagedFdmNativeLayerViews = stageVisibility.fieldDrivenLayers
    ? fdmNativeLayerViews
    : fdmNativeLayerViews.map((view) => ({
        ...view,
        fieldVector: null,
        surfaceColors: null,
        vectorGlyphColors: null,
        vectorSegments: null,
      }));
  const stagedFdmMultilayerAirboxView =
    stageVisibility.fieldDrivenLayers || !fdmMultilayerAirboxView
      ? fdmMultilayerAirboxView
      : {
          ...fdmMultilayerAirboxView,
          fieldVector: null,
          surfaceColors: null,
          vectorGlyphColors: null,
          vectorSegments: null,
        };
  const fdmAirboxMeshSettings = fdmUniverseOutsideSupportSettings
    ? {
        ...fdmUniverseOutsideSupportSettings,
        boundsVisible: false,
        shaderVisible: false,
      }
    : null;
  const stagedMeshQualityColors = stageVisibility.fieldDrivenLayers
    ? meshQualityColors
    : null;
  const stagedMeshQualityOverlayVisible =
    stageVisibility.fieldDrivenLayers && meshQualityOverlayVisible;

  return (
    <>
      {authoredRegionOverlaysVisible ? (
        <RegionOverlayNativePickingLayer
          onSelectRegion={onSelectRegion}
          regions={regionOverlays}
          selectedObjectId={selectedObjectId}
          selectedRegionId={selectedRegionId}
        />
      ) : null}
      {stageVisibility.baseGeometry &&
      viewport3DFdmCuboidLayerEnabledFromBrowserConfig() ? (
        <>
          {stagedFdmNativeLayerViews.map((view) => (
            <FdmCuboidLayer
              adoptionRegistry={adoptionRegistry}
              carrierId={view.target.id}
              colors={colors}
              fieldVector={view.fieldVector}
              instanceModel={view.model}
              inspectEnabled={false}
              inspectQuantityId={view.settings.activeQuantityId}
              key={view.target.id}
              materialProfile={materialProfile}
              onSelectDomain={onSelectDomain}
              onSelectTarget={() => onSelectFdmTarget(view.target)}
              onSelectFdmCell={undefined}
              onSelectRegion={undefined}
              regionOverlays={[]}
              selectedObjectId={selectedObjectId}
              selectedRegionId={selectedRegionId}
              settings={view.settings}
              surfaceColors={view.surfaceColors}
              tracker={tracker}
              vectorColorMode={vectorColorMode}
              vectorGlyphColors={view.vectorGlyphColors?.colors ?? null}
              vectorSegments={view.vectorSegments}
              vectorStyle={vectorStyle}
            />
          ))}
          {stagedFdmMultilayerAirboxView ? (
            <FdmCuboidLayer
              adoptionRegistry={adoptionRegistry}
              carrierId={stagedFdmMultilayerAirboxView.target.id}
              colors={colors}
              fieldVector={stagedFdmMultilayerAirboxView.fieldVector}
              instanceModel={stagedFdmMultilayerAirboxView.model}
              inspectEnabled={false}
              inspectQuantityId={stagedFdmMultilayerAirboxView.settings.activeQuantityId}
              key={stagedFdmMultilayerAirboxView.target.id}
              materialProfile={materialProfile}
              onSelectDomain={onSelectDomain}
              onSelectTarget={() =>
                onSelectFdmTarget(stagedFdmMultilayerAirboxView.target)
              }
              onSelectFdmCell={undefined}
              onSelectRegion={undefined}
              regionOverlays={[]}
              selectedObjectId={selectedObjectId}
              selectedRegionId={selectedRegionId}
              settings={stagedFdmMultilayerAirboxView.settings}
              surfaceColors={stagedFdmMultilayerAirboxView.surfaceColors}
              tracker={tracker}
              vectorColorMode={stagedFdmMultilayerAirboxView.settings.vectorColorMode}
              vectorGlyphColors={
                stagedFdmMultilayerAirboxView.vectorGlyphColors?.colors ?? null
              }
              vectorSegments={stagedFdmMultilayerAirboxView.vectorSegments}
              vectorStyle={vectorStyle}
            />
          ) : null}
          {stagedFdmTargetViews.map((view) => (
            <FdmCuboidLayer
              adoptionRegistry={adoptionRegistry}
              carrierId={view.target.id}
              colors={colors}
              fieldVector={view.fieldVector}
              geometryScopeInstanceOrdinals={view.surfaceInstanceOrdinals}
              instanceModel={view.sourceModel}
              instanceOrdinals={view.instanceOrdinals}
              inspectEnabled={inspectEnabled}
              inspectQuantityId={view.settings.activeQuantityId}
              key={view.target.id}
              materialProfile={materialProfile}
              onInspectClear={onInspectClear}
              onInspectSample={onInspectSample}
              onSelectDomain={onSelectDomain}
              onSelectTarget={() => onSelectFdmTarget(view.target)}
              onSelectFdmCell={onSelectFdmCell}
              onSelectRegion={onSelectRegion}
              regionOverlays={authoredRegionOverlaysVisible ? regionOverlays : []}
              selectedObjectId={selectedObjectId}
              selectedRegionId={selectedRegionId}
              settings={view.settings}
              surfaceColors={view.surfaceColors}
              tracker={tracker}
              vectorColorMode={vectorColorMode}
              vectorBuildReference={view.vectorBuildReference}
              vectorGlyphColors={view.vectorGlyphColors?.colors ?? null}
              vectorSegments={view.vectorSegments}
              vectorStyle={vectorStyle}
            />
          ))}
        </>
      ) : null}
      {stageVisibility.baseGeometry &&
      viewport3DFdmCuboidLayerEnabledFromBrowserConfig() &&
      fdmAirboxPassPlan.needsInactiveCellGeometry && fdmAirboxMeshSettings ? (
        <FdmCuboidLayer
          adoptionRegistry={adoptionRegistry}
          carrierId="fdm-universe-outside-support"
          colors={colors}
          fieldVector={fdmAirboxFieldVector}
          vectorGlyphColors={fdmAirboxVectorGlyphColors?.colors ?? null}
          instanceModel={fdmAirboxInstanceModel}
          inspectEnabled={false}
          inspectQuantityId="m"
          materialProfile={materialProfile}
          onSelectDomain={onSelectFdmUniverseOutsideSupport}
          regionOverlays={[]}
          settings={fdmAirboxMeshSettings}
          surfaceColors={null}
          tracker={tracker}
          vectorColorMode={fdmAirboxMeshSettings.vectorColorMode}
          vectorBuildReference={fdmAirboxVectorBuildReference}
          vectorSegments={fdmAirboxVectorSegments}
          vectorStyle={vectorStyle}
        />
      ) : null}
      {!fdmLaneActive &&
      stageVisibility.baseGeometry &&
      viewport3DAirboxLayerEnabledFromBrowserConfig() ? (
        <AirboxLayer
          adoptionRegistry={adoptionRegistry}
          colors={colors}
          fieldModel={stagedFieldModel}
          materialProfile={materialProfile}
          onSelectPart={onSelectPart}
          settings={airboxSettings}
          topologyModel={topologyModel}
          topologyFreshness={topologyFreshness}
          tracker={tracker}
          vectorColorMode={vectorColorMode}
          vectorStyle={vectorStyle}
        />
      ) : null}
      {stageVisibility.primitiveObjects &&
      viewport3DPrimitiveObjectLayerEnabledFromBrowserConfig() ? (
        <PrimitiveObjectLayer
          colors={colors}
          getObjectSettings={getObjectSettings}
          materialProfile={materialProfile}
          onSelectObject={onSelectObject}
          primitiveModel={primitiveModel}
          realizedObjectIds={realizedFdmObjectIds}
          tracker={tracker}
        />
      ) : null}
      {!fdmLaneActive &&
      stageVisibility.baseGeometry &&
      viewport3DTopologyMeshLayerEnabledFromBrowserConfig() ? (
        <TopologyMeshLayer
          adoptionRegistry={adoptionRegistry}
          colors={colors}
          fieldModel={stagedFieldModel}
          getPartSettings={getPartSettings}
          materialProfile={materialProfile}
          magnetizationTexturePreviews={magnetizationTexturePreviews}
          meshQualityColors={stagedMeshQualityColors}
          meshQualityOverlayVisible={stagedMeshQualityOverlayVisible}
          onSelectPart={onSelectPart}
          tracker={tracker}
          topologyFreshness={topologyFreshness}
          topologyModel={topologyModel}
          vectorColorMode={vectorColorMode}
          vectorStyle={vectorStyle}
        />
      ) : null}
      {realizedRegionOverlaysVisible ? (
        <RegionMeshOverlayLayer
          models={realizedRegionOverlayModels.models}
          onSelectRegion={onSelectRegion}
          targetVisualizationRevision={visualizationRevision}
          topologyRevision={topologyRevision}
          tracker={tracker}
        />
      ) : null}
      <PeriodicPairsOverlayLayer model={periodicOverlayModel} tracker={tracker} />
      {authoredRegionOverlaysVisible ? (
        <RegionOverlayLayer
          onSelectRegion={onSelectRegion}
          regions={regionOverlays}
          selectedObjectId={selectedObjectId}
          selectedRegionId={selectedRegionId}
        />
      ) : null}
      {stageVisibility.meshSizeHighlight &&
      viewport3DMeshSizeHighlightLayerEnabledFromBrowserConfig() ? (
        <MeshSizeHighlightLayer
          colors={colors}
          model={meshSizeHighlightModel}
          tracker={tracker}
        />
      ) : null}
      {stageVisibility.hysteresisReplayGlyphs ? (
        <HysteresisReplayGlyphLayer
          bounds={bounds}
          glyphModel={hysteresisReplayGlyphModel}
          tracker={tracker}
        />
      ) : null}
    </>
  );
}

function RegionOverlayNativePickingLayer({
  onSelectRegion,
  regions,
  selectedObjectId,
  selectedRegionId,
}: {
  onSelectRegion: (selection: RegionOverlaySelection) => void;
  regions: readonly RegionOverlayInput[];
  selectedObjectId: string | null;
  selectedRegionId: string | null;
}) {
  const { camera, gl } = useThree();
  const regionPickModels = useMemo(
    () =>
      buildRegionOverlayModels(regions, {
        selectedObjectId,
        selectedRegionId,
      }),
    [regions, selectedObjectId, selectedRegionId],
  );
  const handleSelectRegion = useEffectEvent(onSelectRegion);

  useEffect(() => {
    if (regionPickModels.length === 0) return undefined;

    const canvas = gl.domElement;
    const pointer = new Vector2();
    const raycaster = new Raycaster();
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const pickedRegion = pickRegionOverlayFromRay(
        raycaster.ray,
        regionPickModels,
      );
      if (!pickedRegion) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      handleSelectRegion(pickedRegion);
    };

    canvas.addEventListener("pointerdown", handlePointerDown, { capture: true });
    return () => {
      canvas.removeEventListener("pointerdown", handlePointerDown, {
        capture: true,
      });
    };
  }, [camera, gl, regionPickModels]);

  return null;
}

function Viewport3DInteractionAndHudStack({
  bounds,
  cameraGestureRef,
  cameraOrthographicScale,
  cameraProjection,
  cameraState,
  colors,
  hslReferenceVisible,
  onCameraChange,
  onCameraInteractionEnd,
  onCameraInteractionStart,
  onOrbitDebugAnglesChange,
  orbitDebugAngles,
  orbitDebugCommitRevision,
  orbitDebugRevision,
  rotationMode,
  tracker,
  viewCubeVisible,
}: Pick<
  Viewport3DSceneProps,
  | "bounds"
  | "cameraOrthographicScale"
  | "cameraProjection"
  | "cameraState"
  | "colors"
  | "hslReferenceVisible"
  | "onCameraChange"
  | "onCameraInteractionEnd"
  | "onCameraInteractionStart"
  | "onOrbitDebugAnglesChange"
  | "orbitDebugAngles"
  | "orbitDebugCommitRevision"
  | "orbitDebugRevision"
  | "rotationMode"
  | "tracker"
  | "viewCubeVisible"
> & {
  cameraGestureRef: ReturnType<typeof createViewport3DCameraGestureRef>;
}) {
  return (
    <>
      <OrbitCameraControls
        bounds={bounds}
        cameraGestureRef={cameraGestureRef}
        cameraOrthographicScale={cameraOrthographicScale}
        cameraProjection={cameraProjection}
        cameraState={cameraState}
        orbitDebugAngles={orbitDebugAngles}
        orbitDebugCommitRevision={orbitDebugCommitRevision}
        orbitDebugRevision={orbitDebugRevision}
        onCameraChange={onCameraChange}
        onCameraInteractionEnd={onCameraInteractionEnd}
        onCameraInteractionStart={onCameraInteractionStart}
        onOrbitDebugAnglesChange={onOrbitDebugAnglesChange}
        tracker={tracker}
      />
      {viewport3DOrientationHudEnabledFromBrowserConfig() ? (
        <OrientationHudLayer
          colors={colors}
          hslReferenceVisible={hslReferenceVisible}
          onCameraChange={onCameraChange}
          onCameraInteractionEnd={onCameraInteractionEnd}
          onCameraInteractionStart={onCameraInteractionStart}
          rotationMode={rotationMode}
          tracker={tracker}
          viewCubeVisible={viewCubeVisible}
        />
      ) : null}
      {viewport3DPostProcessingEnabledFromBrowserConfig() ? (
        <PostProcessingLayer />
      ) : null}
    </>
  );
}

function useViewport3DRenderAdoptionFrame({
  adoptionRegistry,
  invalidate,
  onVisualizationFrameCommitted,
  tracker,
  visualizationRevision,
}: {
  adoptionRegistry?: Viewport3DRenderAdoptionRegistry;
  invalidate: () => void;
  onVisualizationFrameCommitted: (revision: number) => void;
  tracker: Viewport3DResourceTracker;
  visualizationRevision: number | null;
}) {
  useEffect(() => {
    if (!adoptionRegistry) return;
    let frameId: number | null = null;
    const unsubscribe = adoptionRegistry.subscribe(() => {
      tracker.recordDirtyFrame("render-adoption");
      invalidate();
      if (
        frameId !== null ||
        visualizationRevision === null ||
        typeof window === "undefined"
      ) {
        return;
      }
      // idle-audit-allow-one-shot-raf: acknowledge adoption after its invalidated frame.
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        onVisualizationFrameCommitted(visualizationRevision);
      });
    });
    return () => {
      unsubscribe();
      if (frameId !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [
    adoptionRegistry,
    invalidate,
    onVisualizationFrameCommitted,
    tracker,
    visualizationRevision,
  ]);
}

export function Viewport3DScene({
  adoptionRegistry,
  bounds,
  cameraOrthographicScale,
  cameraProjection,
  cameraState,
  colors,
  fdmAirboxFieldVector,
  clip,
  clipFrameRotationDegrees,
  clipIntersectionMarkers,
  crossSectionFrameClip,
  crossSectionFrameRotationDegrees,
  planarMonitorFramePreview,
  dimensionFrameDensity,
  dimensionFrameMode,
  fdmLaneActive,
  fdmAirboxInstanceModel,
  fdmAirboxPassPlan,
  airboxSettings,
  fdmDomain,
  fdmUniverseOutsideSupport,
  fdmUniverseOutsideSupportSettings,
  fdmAirboxVectorGlyphColors,
  fdmAirboxVectorBuildReference,
  fdmAirboxVectorSegments,
  fdmMultilayerAirboxView,
  fdmNativeLayerViews,
  fdmTargetViews,
  fdmSettings,
  fieldModel,
  fitRevision,
  getObjectSettings,
  getPartSettings,
  hysteresisReplayGlyphModel,
  magnetizationTexturePreviews,
  meshQualityColors,
  meshQualityOverlayVisible,
  meshRegionOverlayParts,
  meshRegionOverlays,
  periodicOverlayModel,
  meshSizeHighlightModel,
  onCameraChange,
  onCameraInteractionEnd,
  onCameraInteractionStart,
  onOrbitDebugAnglesChange,
  onVisualizationFrameCommitted,
  onSelectObject,
  onSelectDomain,
  onSelectFdmTarget,
  onSelectFdmUniverseOutsideSupport,
  onSelectFdmCell,
  onSelectPart,
  onSelectRegion,
  orbitDebugAngles,
  orbitDebugCommitRevision,
  orbitDebugRevision,
  primitiveModel,
  regionOverlayMode,
  regionOverlays,
  resetCameraRevision,
  requestDiagnostics,
  resourceFrameKey,
  rotationMode,
  selectionBounds,
  selectedObjectId,
  selectedRegionId,
  tracker,
  topology,
  topologyFreshness,
  topologyModel,
  topologyRevision,
  vectorColorMode,
  vectorStyle,
  visualizationRevision,
  hslReferenceVisible,
  inspectEnabled,
  onInspectClear,
  onInspectSample,
  scaleLabelsVisible,
  scaleUnitMode,
  viewCubeVisible,
  visualProfileId,
}: Viewport3DSceneProps) {
  const invalidate = useThree((state) => state.invalidate);
  const setThreeState = useThree((state) => state.set);
  const viewportSize = useThree((state) => state.size);
  const orthographicCameraRef = useRef<ThreeOrthographicCamera>(null);
  const perspectiveCameraRef = useRef<ThreePerspectiveCamera>(null);
  const appliedCameraClipRef = useRef<{
    camera: Viewport3DProjectionCamera;
    clip: Viewport3DCameraClip;
  } | null>(null);
  const cameraGestureRef = useMemo(() => createViewport3DCameraGestureRef(), []);
  const effectiveCameraState = useMemo(
    () => resolveViewport3DEffectiveCameraState({ bounds, cameraState }),
    [bounds, cameraState],
  );
  const cameraClip = useMemo(
    () => resolveViewport3DProjectionCameraClip(bounds, effectiveCameraState),
    [bounds, effectiveCameraState],
  );
  const orthographicCameraFrame = useMemo(
    () =>
      resolveViewport3DOrthographicCameraFrame(
        bounds,
        viewportSize,
        effectiveCameraState,
        cameraOrthographicScale,
      ),
    [bounds, cameraOrthographicScale, effectiveCameraState, viewportSize],
  );
  const visualProfile = useMemo(
    () => getViewport3DVisualProfile(visualProfileId),
    [visualProfileId],
  );
  const materialProfile = useMemo(
    () => resolveViewport3DMaterialProfile(visualProfile),
    [visualProfile],
  );

  useViewport3DRenderAdoptionFrame({
    adoptionRegistry,
    invalidate,
    onVisualizationFrameCommitted,
    tracker,
    visualizationRevision,
  });

  useLayoutEffect(() => {
    if (cameraProjection === "orthographic") {
      const activeCamera = orthographicCameraRef.current;
      if (!activeCamera) return;
      setThreeState({ camera: activeCamera });
      applyViewport3DOrthographicCameraPose(
        activeCamera,
        effectiveCameraState,
        cameraClip.near,
        cameraClip.far,
      );
    } else {
      const activeCamera = perspectiveCameraRef.current;
      if (!activeCamera) return;
      setThreeState({ camera: activeCamera });
      applyViewport3DPerspectiveCameraPose(
        activeCamera,
        effectiveCameraState,
        cameraClip.near,
        cameraClip.far,
        PERSPECTIVE_CAMERA_FOV_DEGREES,
      );
    }
    return scheduleViewport3DProjectionRenderFrames({ invalidate, tracker });
    // Camera pose is applied only on projection change or mount — not on every
    // camera state update.  OrbitControls owns the live camera position during
    // interaction; re-applying React state on every debounced update would
    // overwrite the current OrbitControls position and cause visible "rewind".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraProjection, invalidate, setThreeState, tracker]);

  // Bounds/resource changes still need to refresh clipping, but updating the
  // clip planes must not re-apply the declarative pose while OrbitControls is
  // moving the live camera.
  useLayoutEffect(() => {
    const activeCamera =
      cameraProjection === "orthographic"
        ? orthographicCameraRef.current
        : perspectiveCameraRef.current;
    if (!activeCamera) return;
    if (
      !shouldApplyViewport3DProjectionCameraClip({
        camera: activeCamera,
        clip: cameraClip,
        previous: appliedCameraClipRef.current,
      })
    ) {
      return;
    }
    activeCamera.near = cameraClip.near;
    activeCamera.far = cameraClip.far;
    activeCamera.updateProjectionMatrix();
    appliedCameraClipRef.current = { camera: activeCamera, clip: cameraClip };
    tracker.recordDirtyFrame("camera-clip");
    invalidate();
  }, [cameraClip, cameraProjection, invalidate, tracker]);

  // Demand rendering needs an explicit frame when async resources settle.
  useEffect(() => {
    tracker.recordDirtyFrame("resources-updated");
    invalidate();
    if (visualizationRevision === null || typeof window === "undefined") return;

    // idle-audit-allow-one-shot-raf: demand rendering needs one post-invalidate frame ack.
    const frameId = window.requestAnimationFrame(() => {
      onVisualizationFrameCommitted(visualizationRevision);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [
    invalidate,
    onVisualizationFrameCommitted,
    resourceFrameKey,
    tracker,
    visualizationRevision,
  ]);

  return (
    <VectorGlyphDerivedBufferCacheProvider tracker={tracker}>
      <color attach="background" args={[colors.background]} />
      <Viewport3DLightingRig profileId={visualProfileId} />
      {viewport3DCanvasLifecycleProbeEnabledFromBrowserConfig() ? (
        <CanvasLifecycleProbe diagnostics={requestDiagnostics} tracker={tracker} />
      ) : null}
      <Viewport3DProjectionStack
        bounds={bounds}
        cameraClip={cameraClip}
        cameraGestureRef={cameraGestureRef}
        cameraState={effectiveCameraState}
        fitRevision={fitRevision}
        onCameraChange={onCameraChange}
        orthographicCameraFrame={orthographicCameraFrame}
        orthographicCameraRef={orthographicCameraRef}
        perspectiveCameraRef={perspectiveCameraRef}
        resetCameraRevision={resetCameraRevision}
        tracker={tracker}
      />
      <Viewport3DOverlayLayerStack
        bounds={bounds}
        cameraProjection={cameraProjection}
        cameraState={effectiveCameraState}
        clip={clip}
        clipFrameRotationDegrees={clipFrameRotationDegrees}
        clipIntersectionMarkers={clipIntersectionMarkers}
        colors={colors}
        crossSectionFrameClip={crossSectionFrameClip}
        crossSectionFrameRotationDegrees={crossSectionFrameRotationDegrees}
        planarMonitorFramePreview={planarMonitorFramePreview}
        dimensionFrameDensity={dimensionFrameDensity}
        dimensionFrameMode={dimensionFrameMode}
        fdmAirboxPassPlan={fdmAirboxPassPlan}
        fdmDomain={fdmDomain}
        fdmMultilayerAirboxView={fdmMultilayerAirboxView}
        fdmUniverseOutsideSupport={fdmUniverseOutsideSupport}
        fdmUniverseOutsideSupportSettings={fdmUniverseOutsideSupportSettings}
        fdmSettings={fdmSettings}
        materialProfile={materialProfile}
        onSelectDomain={onSelectDomain}
        onSelectFdmTarget={onSelectFdmTarget}
        onSelectFdmUniverseOutsideSupport={onSelectFdmUniverseOutsideSupport}
        scaleLabelsVisible={scaleLabelsVisible}
        scaleUnitMode={scaleUnitMode}
        selectionBounds={selectionBounds}
        tracker={tracker}
      />
      <Viewport3DModelLayerStack
        adoptionRegistry={adoptionRegistry}
        airboxSettings={airboxSettings}
        bounds={bounds}
        colors={colors}
        fdmLaneActive={fdmLaneActive}
        fdmAirboxFieldVector={fdmAirboxFieldVector}
        fdmAirboxInstanceModel={fdmAirboxInstanceModel}
        fdmAirboxPassPlan={fdmAirboxPassPlan}
        fdmAirboxVectorGlyphColors={fdmAirboxVectorGlyphColors}
        fdmAirboxVectorBuildReference={fdmAirboxVectorBuildReference}
        fdmAirboxVectorSegments={fdmAirboxVectorSegments}
        fdmMultilayerAirboxView={fdmMultilayerAirboxView}
        fdmNativeLayerViews={fdmNativeLayerViews}
        fdmTargetViews={fdmTargetViews}
        fdmUniverseOutsideSupportSettings={fdmUniverseOutsideSupportSettings}
        fieldModel={fieldModel}
        inspectEnabled={inspectEnabled}
        getObjectSettings={getObjectSettings}
        getPartSettings={getPartSettings}
        hysteresisReplayGlyphModel={hysteresisReplayGlyphModel}
        magnetizationTexturePreviews={magnetizationTexturePreviews}
        materialProfile={materialProfile}
        meshQualityColors={meshQualityColors}
        meshQualityOverlayVisible={meshQualityOverlayVisible}
        meshRegionOverlayParts={meshRegionOverlayParts}
        meshRegionOverlays={meshRegionOverlays}
        periodicOverlayModel={periodicOverlayModel}
        meshSizeHighlightModel={meshSizeHighlightModel}
        onInspectClear={onInspectClear}
        onInspectSample={onInspectSample}
        onSelectDomain={onSelectDomain}
        onSelectFdmTarget={onSelectFdmTarget}
        onSelectFdmUniverseOutsideSupport={onSelectFdmUniverseOutsideSupport}
        onSelectFdmCell={onSelectFdmCell}
        onSelectObject={onSelectObject}
        onSelectPart={onSelectPart}
        onSelectRegion={onSelectRegion}
        primitiveModel={primitiveModel}
        regionOverlayMode={regionOverlayMode}
        regionOverlays={regionOverlays}
        selectedObjectId={selectedObjectId}
        selectedRegionId={selectedRegionId}
        topology={topology}
        topologyFreshness={topologyFreshness}
        topologyModel={topologyModel}
        topologyRevision={topologyRevision}
        tracker={tracker}
        vectorColorMode={vectorColorMode}
        vectorStyle={vectorStyle}
        visualizationRevision={visualizationRevision}
      />
      <Viewport3DInteractionAndHudStack
        bounds={bounds}
        cameraGestureRef={cameraGestureRef}
        cameraOrthographicScale={cameraOrthographicScale}
        cameraProjection={cameraProjection}
        cameraState={effectiveCameraState}
        colors={colors}
        hslReferenceVisible={hslReferenceVisible}
        orbitDebugAngles={orbitDebugAngles}
        orbitDebugCommitRevision={orbitDebugCommitRevision}
        orbitDebugRevision={orbitDebugRevision}
        onCameraChange={onCameraChange}
        onCameraInteractionEnd={onCameraInteractionEnd}
        onCameraInteractionStart={onCameraInteractionStart}
        onOrbitDebugAnglesChange={onOrbitDebugAnglesChange}
        rotationMode={rotationMode}
        tracker={tracker}
        viewCubeVisible={viewCubeVisible}
      />
    </VectorGlyphDerivedBufferCacheProvider>
  );
}
