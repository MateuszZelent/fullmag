"use client";

import type { DecodedFieldVector } from "@/kernel/api/codecs";
import { OrthographicCamera, PerspectiveCamera } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
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
  resolveViewport3DCameraFit,
  type Viewport3DCameraChange,
} from "./CameraControls";
import { CanvasLifecycleProbe } from "./CanvasLifecycleProbe";
import {
  AirboxLayer,
  DomainBoxLayer,
  SelectionHighlightLayer,
} from "./BoundsLayers";
import { TopologyMeshLayer } from "./TopologyMeshLayer";
import { PostProcessingLayer } from "./PostProcessingLayer";
import { PrimitiveObjectLayer } from "./PrimitiveObjectLayer";
import { FdmCuboidLayer, type FdmCuboidInstanceModel } from "./FdmCuboidLayer";
import { Viewport3DLightingRig } from "./Viewport3DLightingRig";
import {
  getViewport3DVisualProfile,
  type Viewport3DVisualProfileId,
} from "../viewport3dVisualProfile";
import { resolveViewport3DMaterialProfile } from "./viewport3DMaterialProfile";
import { clampNumber } from "../viewport3dMath";

interface Viewport3DSceneProps {
  bounds: Viewport3DBounds | null;
  cameraOrthographicScale: number | null;
  cameraProjection: Viewport3DCameraProjection;
  cameraState: Viewport3DCameraState;
  colors: Viewport3DColors;
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
  onCameraChange: (camera: Viewport3DCameraChange) => Promise<void> | void;
  onCameraInteractionEnd?: () => void;
  onCameraInteractionStart?: () => void;
  onVisualizationFrameCommitted: (revision: number) => void;
  onSelectObject: (object: Viewport3DPrimitiveObject) => void;
  onSelectDomain: () => void;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  fallbackSettings: VisualizationTargetSettings;
  primitiveModel: Viewport3DPrimitiveRenderModel | null;
  resetCameraRevision: number;
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
  const orbitFar = Number.isFinite(distance) && distance > 0
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
  frameHost?: Pick<Window, "cancelAnimationFrame" | "requestAnimationFrame"> | null;
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

export function Viewport3DScene({
  bounds,
  cameraOrthographicScale,
  cameraProjection,
  cameraState,
  colors,
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
  onCameraChange,
  onCameraInteractionEnd,
  onCameraInteractionStart,
  onVisualizationFrameCommitted,
  onSelectObject,
  onSelectDomain,
  onSelectPart,
  primitiveModel,
  resetCameraRevision,
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
  const materialProfile = useMemo(
    () =>
      resolveViewport3DMaterialProfile(
        getViewport3DVisualProfile(visualProfileId),
      ),
    [visualProfileId],
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
      <CanvasLifecycleProbe tracker={tracker} />
      <OrthographicCamera
        key="viewport-3d-orthographic-camera"
        ref={orthographicCameraRef}
        bottom={orthographicCameraFrame.bottom}
        left={orthographicCameraFrame.left}
        near={cameraClip.near}
        far={cameraClip.far}
        position={cameraState.position}
        right={orthographicCameraFrame.right}
        top={orthographicCameraFrame.top}
        up={cameraState.up}
        zoom={orthographicCameraFrame.zoom}
        onUpdate={(camera) =>
          applyViewport3DOrthographicCameraPose(
            camera,
            cameraState,
            cameraClip.near,
            cameraClip.far,
          )
        }
      />
      <PerspectiveCamera
        key="viewport-3d-perspective-camera"
        ref={perspectiveCameraRef}
        far={cameraClip.far}
        fov={PERSPECTIVE_CAMERA_FOV_DEGREES}
        near={cameraClip.near}
        position={cameraState.position}
        up={cameraState.up}
        onUpdate={(camera) =>
          applyViewport3DPerspectiveCameraPose(
            camera,
            cameraState,
            cameraClip.near,
            cameraClip.far,
            PERSPECTIVE_CAMERA_FOV_DEGREES,
          )
        }
      />
      <CameraController
        bounds={bounds}
        cameraState={cameraState}
        fitRevision={fitRevision}
        onCameraChange={onCameraChange}
        resetCameraRevision={resetCameraRevision}
        tracker={tracker}
      />
      <DomainBoxLayer
        bounds={bounds}
        boundsVisible={fdmSettings.boundsVisible}
        colors={colors}
        onSelectDomain={onSelectDomain}
      />
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
        voxelFillRatio={getViewport3DVisualProfile(visualProfileId).voxelFillRatio}
        voxelMagnitudeThreshold={
          getViewport3DVisualProfile(visualProfileId).voxelMagnitudeThreshold
        }
        voxelTopography={getViewport3DVisualProfile(visualProfileId).voxelTopography}
      />
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
      <PrimitiveObjectLayer
        colors={colors}
        getObjectSettings={getObjectSettings}
        materialProfile={materialProfile}
        onSelectObject={onSelectObject}
        primitiveModel={primitiveModel}
        tracker={tracker}
      />
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
      <SelectionHighlightLayer
        bounds={selectionBounds}
        colors={colors}
        materialProfile={materialProfile}
      />
      <DimensionFrameLayer
        bounds={bounds}
        cameraProjection={cameraProjection}
        cameraState={cameraState}
        colors={colors}
        density={dimensionFrameDensity}
        labelsVisible={scaleLabelsVisible}
        materialProfile={materialProfile}
        mode={dimensionFrameMode}
        tracker={tracker}
        unitMode={scaleUnitMode}
      />
      <OrbitCameraControls
        cameraOrthographicScale={cameraOrthographicScale}
        cameraProjection={cameraProjection}
        cameraState={cameraState}
        onCameraChange={onCameraChange}
        onCameraInteractionEnd={onCameraInteractionEnd}
        onCameraInteractionStart={onCameraInteractionStart}
        tracker={tracker}
      />
      <OrientationHudLayer
        colors={colors}
        hslReferenceVisible={hslReferenceVisible}
        onCameraChange={onCameraChange}
        onCameraInteractionEnd={onCameraInteractionEnd}
        onCameraInteractionStart={onCameraInteractionStart}
        rotationMode={rotationMode}
        viewCubeVisible={viewCubeVisible}
      />
      <PostProcessingLayer />
    </>
  );
}
