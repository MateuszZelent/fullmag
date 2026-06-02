"use client";

import type { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";
import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import type { DecodedFieldVector } from "@/kernel/api/codecs";
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
  useLayoutEffect,
  useMemo,
  useRef,
  type RefObject,
} from "react";
import {
  Vector3,
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
import { PostProcessingLayer } from "./PostProcessingLayer";
import { PrimitiveObjectLayer } from "./PrimitiveObjectLayer";
import { FdmCuboidLayer, type FdmCuboidInstanceModel } from "./FdmCuboidLayer";
import { Viewport3DLightingRig } from "./Viewport3DLightingRig";
import { ClipPlaneFramePreviewLayer, ClipPlaneLayer } from "./ClipPlaneLayer";
import type { ClipPlaneIntersectionMarkerBuffers } from "./clipPlaneModel";
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
  fieldVector: DecodedFieldVector | null | undefined;
  femDomain: FemManifestRenderDomain;
  fieldModel: Viewport3DFieldRenderModel | null;
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
  meshSizeHighlightModel: Viewport3DMeshSizeHighlightModel | null;
  onCameraChange: (camera: Viewport3DCameraChange) => Promise<void> | void;
  onCameraInteractionEnd?: () => void;
  onCameraInteractionStart?: () => void;
  onOrbitDebugAnglesChange?: (angles: Viewport3DOrbitDebugAngles) => void;
  onVisualizationFrameCommitted: (revision: number) => void;
  onSelectObject: (object: Viewport3DPrimitiveObject) => void;
  onSelectDomain: () => void;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  orbitDebugAngles: Viewport3DOrbitDebugAngles;
  orbitDebugCommitRevision: number;
  orbitDebugRevision: number;
  fallbackSettings: VisualizationTargetSettings;
  primitiveModel: Viewport3DPrimitiveRenderModel | null;
  resetCameraRevision: number;
  requestDiagnostics: RequestDiagnosticsController;
  resourceFrameKey: string;
  rotationMode: Viewport3DRotationMode;
  selectionBounds: Viewport3DBounds | null;
  tracker: Viewport3DResourceTracker;
  topologyFreshness: Viewport3DTopologyFreshness;
  topologyModel: Viewport3DTopologyRenderModel<Viewport3DMeshPart> | null;
  vectorColorMode: string;
  vectorScale: number;
  vectorStyle: VectorFieldLayerVectorStyle;
  visualizationRevision: number | null;
  hslReferenceVisible: boolean;
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
type Viewport3DVisualProfile = ReturnType<typeof getViewport3DVisualProfile>;

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
  colors,
  fdmDomain,
  fdmInstanceModel,
  fdmSettings,
  fdmSurfaceColors,
  fieldModel,
  fieldVector,
  fallbackSettings,
  femDomain,
  getObjectSettings,
  getPartSettings,
  magnetizationTexturePreviews,
  materialProfile,
  maxVectorGlyphs,
  meshQualityColors,
  meshQualityOverlayVisible,
  meshSizeHighlightModel,
  onSelectDomain,
  onSelectObject,
  onSelectPart,
  primitiveModel,
  topologyFreshness,
  topologyModel,
  tracker,
  vectorColorMode,
  vectorScale,
  vectorStyle,
  visualProfile,
}: Pick<
  Viewport3DSceneProps,
  | "airboxSettings"
  | "colors"
  | "fdmDomain"
  | "fdmInstanceModel"
  | "fdmSettings"
  | "fdmSurfaceColors"
  | "fieldModel"
  | "fieldVector"
  | "fallbackSettings"
  | "femDomain"
  | "getObjectSettings"
  | "getPartSettings"
  | "magnetizationTexturePreviews"
  | "maxVectorGlyphs"
  | "meshQualityColors"
  | "meshQualityOverlayVisible"
  | "meshSizeHighlightModel"
  | "onSelectDomain"
  | "onSelectObject"
  | "onSelectPart"
  | "primitiveModel"
  | "topologyFreshness"
  | "topologyModel"
  | "tracker"
  | "vectorColorMode"
  | "vectorScale"
  | "vectorStyle"
> & {
  materialProfile: ReturnType<typeof resolveViewport3DMaterialProfile>;
  visualProfile: Viewport3DVisualProfile;
}) {
  if (!viewport3DSceneLayersEnabledFromBrowserConfig()) return null;

  return (
    <>
      {viewport3DFdmCuboidLayerEnabledFromBrowserConfig() ? (
        <FdmCuboidLayer
          colors={colors}
          domain={fdmDomain}
          fieldVector={fieldVector}
          instanceModel={fdmInstanceModel}
          maxVectorGlyphs={maxVectorGlyphs}
          materialProfile={materialProfile}
          onSelectDomain={onSelectDomain}
          settings={fdmSettings}
          surfaceColors={fdmSurfaceColors}
          tracker={tracker}
          vectorColorMode={vectorColorMode}
          vectorScale={vectorScale}
          vectorStyle={vectorStyle}
          voxelFillRatio={visualProfile.voxelFillRatio}
          voxelMagnitudeThreshold={visualProfile.voxelMagnitudeThreshold}
          voxelTopography={visualProfile.voxelTopography}
        />
      ) : null}
      {viewport3DAirboxLayerEnabledFromBrowserConfig() ? (
        <AirboxLayer
          colors={colors}
          fieldModel={fieldModel}
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
      {viewport3DPrimitiveObjectLayerEnabledFromBrowserConfig() ? (
        <PrimitiveObjectLayer
          colors={colors}
          getObjectSettings={getObjectSettings}
          materialProfile={materialProfile}
          onSelectObject={onSelectObject}
          primitiveModel={primitiveModel}
          tracker={tracker}
        />
      ) : null}
      {viewport3DTopologyMeshLayerEnabledFromBrowserConfig() ? (
        <TopologyMeshLayer
          colors={colors}
          fallbackSettings={fallbackSettings}
          femDomain={femDomain}
          fieldModel={fieldModel}
          getPartSettings={getPartSettings}
          materialProfile={materialProfile}
          magnetizationTexturePreviews={magnetizationTexturePreviews}
          meshQualityColors={meshQualityColors}
          meshQualityOverlayVisible={meshQualityOverlayVisible}
          onSelectDomain={onSelectDomain}
          onSelectPart={onSelectPart}
          tracker={tracker}
          topologyFreshness={topologyFreshness}
          topologyModel={topologyModel}
          vectorColorMode={vectorColorMode}
          vectorStyle={vectorStyle}
        />
      ) : null}
      {viewport3DMeshSizeHighlightLayerEnabledFromBrowserConfig() ? (
        <MeshSizeHighlightLayer
          colors={colors}
          model={meshSizeHighlightModel}
          tracker={tracker}
        />
      ) : null}
    </>
  );
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
  fdmDomain,
  fdmInstanceModel,
  fdmSettings,
  fdmSurfaceColors,
  fieldVector,
  femDomain,
  fieldModel,
  fitRevision,
  fallbackSettings,
  getObjectSettings,
  getPartSettings,
  magnetizationTexturePreviews,
  maxVectorGlyphs,
  meshQualityColors,
  meshQualityOverlayVisible,
  meshSizeHighlightModel,
  onCameraChange,
  onCameraInteractionEnd,
  onCameraInteractionStart,
  onOrbitDebugAnglesChange,
  onVisualizationFrameCommitted,
  onSelectObject,
  onSelectDomain,
  onSelectPart,
  orbitDebugAngles,
  orbitDebugCommitRevision,
  orbitDebugRevision,
  primitiveModel,
  resetCameraRevision,
  requestDiagnostics,
  resourceFrameKey,
  rotationMode,
  selectionBounds,
  tracker,
  topologyFreshness,
  topologyModel,
  vectorColorMode,
  vectorScale,
  vectorStyle,
  visualizationRevision,
  hslReferenceVisible,
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
        colors={colors}
        fdmDomain={fdmDomain}
        fdmInstanceModel={fdmInstanceModel}
        fdmSettings={fdmSettings}
        fdmSurfaceColors={fdmSurfaceColors}
        fieldModel={fieldModel}
        fieldVector={fieldVector}
        fallbackSettings={fallbackSettings}
        femDomain={femDomain}
        getObjectSettings={getObjectSettings}
        getPartSettings={getPartSettings}
        magnetizationTexturePreviews={magnetizationTexturePreviews}
        materialProfile={materialProfile}
        maxVectorGlyphs={maxVectorGlyphs}
        meshQualityColors={meshQualityColors}
        meshQualityOverlayVisible={meshQualityOverlayVisible}
        meshSizeHighlightModel={meshSizeHighlightModel}
        onSelectDomain={onSelectDomain}
        onSelectObject={onSelectObject}
        onSelectPart={onSelectPart}
        primitiveModel={primitiveModel}
        topologyFreshness={topologyFreshness}
        topologyModel={topologyModel}
        tracker={tracker}
        vectorColorMode={vectorColorMode}
        vectorScale={vectorScale}
        vectorStyle={vectorStyle}
        visualProfile={visualProfile}
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
