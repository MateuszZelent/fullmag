"use client";

import type { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";
import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
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
  startTransition,
  type RefObject,
} from "react";
import {
  Raycaster,
  Vector3,
  Vector2,
  type OrthographicCamera as ThreeOrthographicCamera,
  type PerspectiveCamera as ThreePerspectiveCamera,
} from "three";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

import type {
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
  SelectionHighlightLayer,
} from "./BoundsLayers";
import { TopologyMeshLayer } from "./TopologyMeshLayer";
import { MeshSizeHighlightLayer } from "./MeshSizeHighlightLayer";
import {
  RegionOverlayLayer,
  type RegionOverlaySelection,
} from "./RegionOverlayLayer";
import { RegionMeshOverlayLayer } from "./RegionMeshOverlayLayer";
import {
  useViewport3DRegionOverlayModels,
  type Viewport3DRegionOverlayBuildStatus,
} from "../region-overlays/useViewport3DRegionOverlayModels";
import { PostProcessingLayer } from "./PostProcessingLayer";
import { PrimitiveObjectLayer } from "./PrimitiveObjectLayer";
import { FdmCuboidLayer, type FdmCuboidInstanceModel } from "./FdmCuboidLayer";
import { HysteresisReplayGlyphLayer } from "./HysteresisReplayGlyphLayer";
import { Viewport3DLightingRig } from "./Viewport3DLightingRig";
import { ClipPlaneFramePreviewLayer, ClipPlaneLayer } from "./ClipPlaneLayer";
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
import { clampNumber } from "../viewport3dMath";
import { createViewport3DCameraGestureRef } from "./viewport3DCameraGesture";

interface Viewport3DSceneProps {
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
  dimensionFrameDensity: Viewport3DDimensionFrameDensity;
  dimensionFrameMode: Viewport3DDimensionFrameMode;
  airboxSettings: VisualizationTargetSettings;
  fdmDomain: FdmGridRenderDomain | null;
  fdmInstanceModel: FdmCuboidInstanceModel | null | undefined;
  fdmSettings: VisualizationTargetSettings;
  fdmSurfaceColors: ScalarColorBuffer | null;
  fdmVectorSegments: Float32Array | null;
  fieldVector: DecodedFieldVector | null | undefined;
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
  meshSizeHighlightModel: Viewport3DMeshSizeHighlightModel | null;
  onCameraChange: (camera: Viewport3DCameraChange) => Promise<void> | void;
  onCameraInteractionEnd?: () => void;
  onCameraInteractionStart?: () => void;
  onOrbitDebugAnglesChange?: (angles: Viewport3DOrbitDebugAngles) => void;
  onVisualizationFrameCommitted: (revision: number) => void;
  onSelectObject: (object: Viewport3DPrimitiveObject) => void;
  onSelectRegion: (selection: RegionOverlaySelection) => void;
  onSelectDomain: () => void;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  orbitDebugAngles: Viewport3DOrbitDebugAngles;
  orbitDebugCommitRevision: number;
  orbitDebugRevision: number;
  fallbackSettings: VisualizationTargetSettings;
  getRegionSettings: (region: RegionOverlayInput) => VisualizationTargetSettings;
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
  inspectQuantityId: string;
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

const FALLBACK_GRID_SIZE = 1e-6;
const PERSPECTIVE_CAMERA_FOV_DEGREES = 42;

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
  readonly explicitRegionSettingsVisible?: boolean;
  readonly hasMeshBackedRegionOverlays: boolean;
  readonly overlayLayersEnabled: boolean;
  readonly realizedBuildStatus: Viewport3DRegionOverlayBuildStatus;
  readonly regionOverlayMode: RegionOverlayMode;
  readonly stageVisible: boolean;
}

export function resolveAuthoredRegionOverlayVisibility({
  explicitRegionSettingsVisible = false,
  hasMeshBackedRegionOverlays,
  overlayLayersEnabled,
  realizedBuildStatus,
  regionOverlayMode,
  stageVisible,
}: Viewport3DAuthoredRegionOverlayVisibilityInput): boolean {
  if (!stageVisible || !overlayLayersEnabled) return false;
  if (explicitRegionSettingsVisible) return true;
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
  fdmInstanceModel,
  primitiveModel,
  topologyModel,
}: Pick<
  Viewport3DSceneProps,
  "fdmInstanceModel" | "primitiveModel" | "topologyModel"
>): string {
  return [
    topologyModel?.meshGenerationId ?? "no-mesh-generation",
    topologyModel?.meshRevision ?? "no-mesh-revision",
    topologyModel?.nodeCount ?? 0,
    topologyModel?.magneticParts.length ?? 0,
    topologyModel?.airboxParts.length ?? 0,
    primitiveModel?.sceneRevision ?? "no-scene-revision",
    primitiveModel?.objects.length ?? 0,
    fdmInstanceModel ? "fdm-ready" : "fdm-empty",
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
      startTransition(() => {
        setStageState((current) => {
          const currentStage =
            current.resetKey === resetKey ? current.stage : 0;
          return {
            resetKey,
            stage: resolveNextViewport3DModelLayerStage(currentStage),
          };
        });
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
  dimensionFrameDensity,
  dimensionFrameMode,
  fdmSettings,
  materialProfile,
  onSelectDomain,
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
  | "dimensionFrameDensity"
  | "dimensionFrameMode"
  | "fdmSettings"
  | "onSelectDomain"
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
      !clip?.enabled ? (
        <ClipPlaneFramePreviewLayer
          bounds={bounds}
          clip={crossSectionFrameClip}
          colors={colors}
          frameRotationDegrees={crossSectionFrameRotationDegrees}
          tracker={tracker}
        />
      ) : null}
      {viewport3DBoundsLayersEnabledFromBrowserConfig() ? (
        <>
          <DomainBoxLayer
            bounds={bounds}
            boundsVisible={fdmSettings.boundsVisible}
            colors={colors}
            onSelectDomain={onSelectDomain}
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
  airboxSettings,
  bounds,
  colors,
  fdmInstanceModel,
  fdmSettings,
  fdmSurfaceColors,
  fdmVectorSegments,
  fieldModel,
  fieldVector,
  fallbackSettings,
  femDomain,
  getRegionSettings,
  hysteresisReplayGlyphModel,
  getObjectSettings,
  getPartSettings,
  inspectEnabled,
  inspectQuantityId,
  magnetizationTexturePreviews,
  materialProfile,
  meshQualityColors,
  meshQualityOverlayVisible,
  meshRegionOverlayParts,
  meshRegionOverlays,
  meshSizeHighlightModel,
  onInspectClear,
  onInspectSample,
  onSelectDomain,
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
  | "airboxSettings"
  | "bounds"
  | "colors"
  | "fdmInstanceModel"
  | "fdmSettings"
  | "fdmSurfaceColors"
  | "fdmVectorSegments"
  | "fieldModel"
  | "fieldVector"
  | "fallbackSettings"
  | "femDomain"
  | "getRegionSettings"
  | "getObjectSettings"
  | "getPartSettings"
  | "hysteresisReplayGlyphModel"
  | "magnetizationTexturePreviews"
  | "meshQualityColors"
  | "meshQualityOverlayVisible"
  | "meshRegionOverlayParts"
  | "meshRegionOverlays"
  | "meshSizeHighlightModel"
  | "inspectEnabled"
  | "inspectQuantityId"
  | "onInspectClear"
  | "onInspectSample"
  | "onSelectDomain"
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
        fdmInstanceModel,
        primitiveModel,
        topologyModel,
      }),
    [fdmInstanceModel, primitiveModel, topologyModel],
  );
  const modelLayerStage = useViewport3DModelLayerStage({
    resetKey: modelLayerStageKey,
    tracker,
  });
  const stageVisibility =
    resolveViewport3DModelLayerStageVisibility(modelLayerStage);
  const renderedMeshRegionSurfacePartIds = useMemo(
    () =>
      new Set(
        femDomain.magneticParts.flatMap((part) => (part.id ? [part.id] : [])),
    ),
    [femDomain.magneticParts],
  );
  const renderedMeshRegionSurfacePartIdList = useMemo(
    () => [...renderedMeshRegionSurfacePartIds].toSorted(),
    [renderedMeshRegionSurfacePartIds],
  );
  const meshRegionOverlaySettingsByRegionId = useMemo(
    () => resolveRegionSettingsEntries(meshRegionOverlays, getRegionSettings),
    [getRegionSettings, meshRegionOverlays],
  );
  const explicitMeshRegionOverlaysVisible = hasExplicitVisibleRegionSettings(
    meshRegionOverlaySettingsByRegionId,
  );
  const hasMeshBackedRegionOverlays = meshRegionOverlays.length > 0;
  const overlayLayersEnabled = viewport3DOverlayLayersEnabledFromBrowserConfig();
  const realizedRegionOverlaysVisible =
    (explicitMeshRegionOverlaysVisible ||
      regionOverlayModeShowsRealized(
        regionOverlayMode,
        hasMeshBackedRegionOverlays,
      )) &&
    stageVisibility.realizedRegionOverlays &&
    overlayLayersEnabled;
  const realizedRegionOverlayModels = useViewport3DRegionOverlayModels({
    enabled: realizedRegionOverlaysVisible,
    magneticParts: meshRegionOverlayParts,
    regions: meshRegionOverlays,
    renderedSurfacePartIds: renderedMeshRegionSurfacePartIdList,
    selectedObjectId,
    selectedRegionId,
    settingsByRegionId: meshRegionOverlaySettingsByRegionId,
    targetVisualizationRevision: visualizationRevision,
    topology,
    topologyRevision,
  });
  const realizedRegionOverlayBuildStatus = realizedRegionOverlaysVisible
    ? realizedRegionOverlayModels.status
    : "disabled";

  if (!viewport3DSceneLayersEnabledFromBrowserConfig()) return null;

  const authoredRegionOverlaysVisible = resolveAuthoredRegionOverlayVisibility({
    explicitRegionSettingsVisible: hasExplicitVisibleRegionSettings(
      resolveRegionSettingsEntries(regionOverlays, getRegionSettings),
    ),
    hasMeshBackedRegionOverlays,
    overlayLayersEnabled,
    realizedBuildStatus: realizedRegionOverlayBuildStatus,
    regionOverlayMode,
    stageVisible: stageVisibility.authoredRegionOverlays,
  });
  const stagedFieldModel = stageVisibility.fieldDrivenLayers ? fieldModel : null;
  const stagedFieldVector = stageVisibility.fieldDrivenLayers ? fieldVector : null;
  const stagedFdmSurfaceColors = stageVisibility.fieldDrivenLayers
    ? fdmSurfaceColors
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
          getRegionSettings={getRegionSettings}
          onSelectRegion={onSelectRegion}
          regions={regionOverlays}
          selectedObjectId={selectedObjectId}
          selectedRegionId={selectedRegionId}
        />
      ) : null}
      {stageVisibility.baseGeometry &&
      viewport3DFdmCuboidLayerEnabledFromBrowserConfig() ? (
        <FdmCuboidLayer
          colors={colors}
          fieldVector={stagedFieldVector}
          instanceModel={fdmInstanceModel}
          inspectEnabled={inspectEnabled}
          inspectQuantityId={inspectQuantityId}
          materialProfile={materialProfile}
          onInspectClear={onInspectClear}
          onInspectSample={onInspectSample}
          onSelectDomain={onSelectDomain}
          onSelectRegion={onSelectRegion}
          regionOverlays={authoredRegionOverlaysVisible ? regionOverlays : []}
          selectedObjectId={selectedObjectId}
          selectedRegionId={selectedRegionId}
          settings={fdmSettings}
          surfaceColors={stagedFdmSurfaceColors}
          tracker={tracker}
          vectorColorMode={vectorColorMode}
          vectorSegments={fdmVectorSegments}
          vectorStyle={vectorStyle}
        />
      ) : null}
      {stageVisibility.baseGeometry &&
      viewport3DAirboxLayerEnabledFromBrowserConfig() ? (
        <AirboxLayer
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
          tracker={tracker}
        />
      ) : null}
      {stageVisibility.baseGeometry &&
      viewport3DTopologyMeshLayerEnabledFromBrowserConfig() ? (
        <TopologyMeshLayer
          colors={colors}
          fallbackSettings={fallbackSettings}
          femDomain={femDomain}
          fieldModel={stagedFieldModel}
          getPartSettings={getPartSettings}
          materialProfile={materialProfile}
          magnetizationTexturePreviews={magnetizationTexturePreviews}
          meshQualityColors={stagedMeshQualityColors}
          meshQualityOverlayVisible={stagedMeshQualityOverlayVisible}
          onSelectDomain={onSelectDomain}
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
      {authoredRegionOverlaysVisible ? (
        <RegionOverlayLayer
          getRegionSettings={getRegionSettings}
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
  getRegionSettings,
  onSelectRegion,
  regions,
  selectedObjectId,
  selectedRegionId,
}: {
  getRegionSettings: (region: RegionOverlayInput) => VisualizationTargetSettings;
  onSelectRegion: (selection: RegionOverlaySelection) => void;
  regions: readonly RegionOverlayInput[];
  selectedObjectId: string | null;
  selectedRegionId: string | null;
}) {
  const { camera, gl } = useThree();
  const regionPickModels = useMemo(
    () =>
      buildRegionOverlayModels(regions, {
        resolveSettings: getRegionSettings,
        selectedObjectId,
        selectedRegionId,
      }),
    [getRegionSettings, regions, selectedObjectId, selectedRegionId],
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

function resolveRegionSettingsEntries(
  regions: readonly RegionOverlayInput[],
  getRegionSettings: (region: RegionOverlayInput) => VisualizationTargetSettings,
): Array<readonly [string, VisualizationTargetSettings]> {
  return regions.flatMap((region) =>
    typeof region.region_id === "string"
      ? [[region.region_id, getRegionSettings(region)] as const]
      : [],
  );
}

export function hasExplicitVisibleRegionSettings(
  entries: readonly (readonly [string, VisualizationTargetSettings])[],
): boolean {
  return entries.some(([, settings]) => settings.visible);
}

function Viewport3DInteractionAndHudStack({
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
        cameraGestureRef={cameraGestureRef}
        cameraOrthographicScale={cameraOrthographicScale}
        cameraProjection={cameraProjection}
        cameraState={cameraState}
        orbitDebugAngles={orbitDebugAngles}
        orbitDebugCommitRevision={orbitDebugCommitRevision}
        orbitDebugRevision={orbitDebugRevision}
        onCameraChange={onCameraChange}
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

export function Viewport3DScene({
  bounds,
  cameraOrthographicScale,
  cameraProjection,
  cameraState,
  colors,
  clip,
  clipFrameRotationDegrees,
  clipIntersectionMarkers,
  crossSectionFrameClip,
  crossSectionFrameRotationDegrees,
  dimensionFrameDensity,
  dimensionFrameMode,
  airboxSettings,
  fdmInstanceModel,
  fdmSettings,
  fdmSurfaceColors,
  fdmVectorSegments,
  fieldVector,
  femDomain,
  fieldModel,
  fitRevision,
  fallbackSettings,
  getObjectSettings,
  getPartSettings,
  getRegionSettings,
  hysteresisReplayGlyphModel,
  magnetizationTexturePreviews,
  meshQualityColors,
  meshQualityOverlayVisible,
  meshRegionOverlayParts,
  meshRegionOverlays,
  meshSizeHighlightModel,
  onCameraChange,
  onCameraInteractionEnd,
  onCameraInteractionStart,
  onOrbitDebugAnglesChange,
  onVisualizationFrameCommitted,
  onSelectObject,
  onSelectDomain,
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
  inspectQuantityId,
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
  const cameraGestureRef = useMemo(() => createViewport3DCameraGestureRef(), []);
  const cameraClip = useMemo(
    () => resolveViewport3DProjectionCameraClip(bounds, cameraState),
    [bounds, cameraState],
  );
  const orthographicCameraFrame = useMemo(
    () =>
      resolveViewport3DOrthographicCameraFrame(
        bounds,
        viewportSize,
        cameraState,
        cameraOrthographicScale,
      ),
    [bounds, cameraOrthographicScale, cameraState, viewportSize],
  );
  const visualProfile = useMemo(
    () => getViewport3DVisualProfile(visualProfileId),
    [visualProfileId],
  );
  const materialProfile = useMemo(
    () => resolveViewport3DMaterialProfile(visualProfile),
    [visualProfile],
  );

  useLayoutEffect(() => {
    const activeCamera =
      cameraProjection === "orthographic"
        ? orthographicCameraRef.current
        : perspectiveCameraRef.current;
    if (!activeCamera) return;

    setThreeState({ camera: activeCamera });
    activeCamera.updateProjectionMatrix();
    activeCamera.updateMatrixWorld(true);
    return scheduleViewport3DProjectionRenderFrames({ invalidate, tracker });
  }, [cameraProjection, invalidate, setThreeState, tracker]);

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
    <>
      <color attach="background" args={[colors.background]} />
      <Viewport3DLightingRig profileId={visualProfileId} />
      {viewport3DCanvasLifecycleProbeEnabledFromBrowserConfig() ? (
        <CanvasLifecycleProbe diagnostics={requestDiagnostics} tracker={tracker} />
      ) : null}
      <Viewport3DProjectionStack
        bounds={bounds}
        cameraClip={cameraClip}
        cameraGestureRef={cameraGestureRef}
        cameraState={cameraState}
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
        cameraState={cameraState}
        clip={clip}
        clipFrameRotationDegrees={clipFrameRotationDegrees}
        clipIntersectionMarkers={clipIntersectionMarkers}
        colors={colors}
        crossSectionFrameClip={crossSectionFrameClip}
        crossSectionFrameRotationDegrees={crossSectionFrameRotationDegrees}
        dimensionFrameDensity={dimensionFrameDensity}
        dimensionFrameMode={dimensionFrameMode}
        fdmSettings={fdmSettings}
        materialProfile={materialProfile}
        onSelectDomain={onSelectDomain}
        scaleLabelsVisible={scaleLabelsVisible}
        scaleUnitMode={scaleUnitMode}
        selectionBounds={selectionBounds}
        tracker={tracker}
      />
      <Viewport3DModelLayerStack
        airboxSettings={airboxSettings}
        bounds={bounds}
        colors={colors}
        fdmInstanceModel={fdmInstanceModel}
        fdmSettings={fdmSettings}
        fdmSurfaceColors={fdmSurfaceColors}
        fdmVectorSegments={fdmVectorSegments}
        fieldModel={fieldModel}
        fieldVector={fieldVector}
        inspectEnabled={inspectEnabled}
        inspectQuantityId={inspectQuantityId}
        fallbackSettings={fallbackSettings}
        femDomain={femDomain}
        getObjectSettings={getObjectSettings}
        getPartSettings={getPartSettings}
        getRegionSettings={getRegionSettings}
        hysteresisReplayGlyphModel={hysteresisReplayGlyphModel}
        magnetizationTexturePreviews={magnetizationTexturePreviews}
        materialProfile={materialProfile}
        meshQualityColors={meshQualityColors}
        meshQualityOverlayVisible={meshQualityOverlayVisible}
        meshRegionOverlayParts={meshRegionOverlayParts}
        meshRegionOverlays={meshRegionOverlays}
        meshSizeHighlightModel={meshSizeHighlightModel}
        onInspectClear={onInspectClear}
        onInspectSample={onInspectSample}
        onSelectDomain={onSelectDomain}
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
        cameraGestureRef={cameraGestureRef}
        cameraOrthographicScale={cameraOrthographicScale}
        cameraProjection={cameraProjection}
        cameraState={cameraState}
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
    </>
  );
}
