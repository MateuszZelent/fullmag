"use client";

import { OrthographicCamera } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";

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
import type { Viewport3DTopologyFreshness } from "../viewport3dTopologyStaleness";
import type {
  Viewport3DMagnetizationTexturePreview,
  Viewport3DPrimitiveObject,
  Viewport3DPrimitiveRenderModel,
} from "../viewport3dPrimitiveModel";
import type { Viewport3DCameraProjection, Viewport3DCameraState } from "../viewport3dStore";
import type { Viewport3DColors } from "../viewport3dTypes";
import type { VectorFieldLayerVectorStyle } from "./VectorFieldLayer";
import { OrientationHudLayer } from "../orientation/OrientationHudLayer";
import {
  VIEWPORT_3D_WORLD_UP,
  CameraController,
  OrbitCameraControls,
  resolveViewport3DCameraFit,
} from "./CameraControls";
import { CanvasLifecycleProbe } from "./CanvasLifecycleProbe";
import {
  AirboxLayer,
  DomainBoxLayer,
  SelectionHighlightLayer,
} from "./BoundsLayers";
import { TopologyMeshLayer } from "./TopologyMeshLayer";
import { PrimitiveObjectLayer } from "./PrimitiveObjectLayer";
import { FdmCuboidLayer } from "./FdmCuboidLayer";

interface Viewport3DSceneProps {
  bounds: Viewport3DBounds | null;
  cameraProjection: Viewport3DCameraProjection;
  cameraState: Viewport3DCameraState;
  colors: Viewport3DColors;
  airboxSettings: VisualizationTargetSettings;
  fdmDomain: FdmGridRenderDomain | null;
  femDomain: FemManifestRenderDomain;
  fieldModel: Viewport3DFieldRenderModel | null;
  fitRevision: number;
  getObjectSettings: (object: Viewport3DPrimitiveObject) => VisualizationTargetSettings;
  getPartSettings: (part: Viewport3DMeshPart) => VisualizationTargetSettings;
  magnetizationTexturePreviews: Map<string, Viewport3DMagnetizationTexturePreview>;
  onCameraChange: (camera: Viewport3DCameraState) => Promise<void> | void;
  onSelectObject: (object: Viewport3DPrimitiveObject) => void;
  onSelectDomain: () => void;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  fallbackSettings: VisualizationTargetSettings;
  primitiveModel: Viewport3DPrimitiveRenderModel | null;
  resetCameraRevision: number;
  resourceFrameKey: string;
  selectionBounds: Viewport3DBounds | null;
  tracker: Viewport3DResourceTracker;
  topologyFreshness: Viewport3DTopologyFreshness;
  topologyModel: Viewport3DTopologyRenderModel<Viewport3DMeshPart> | null;
  vectorColorMode: string;
  vectorStyle: VectorFieldLayerVectorStyle;
  hslReferenceVisible: boolean;
  viewCubeVisible: boolean;
}

interface Viewport3DGridSpec {
  axesLength: number;
  center: [number, number, number];
  divisions: number;
  size: number;
}

const FALLBACK_GRID_SIZE = 1e-6;
const PREFERRED_GRID_CELL_SIZE = 1e-6;
const GRID_SIZE_UNIVERSE_LIMIT_SCALE = 1.5;
const GRID_TARGET_DIVISIONS = 12;
const GRID_MAX_DIVISIONS = 64;

export function resolveViewport3DGridSpec(
  bounds: Viewport3DBounds | null,
): Viewport3DGridSpec {
  if (!bounds) {
    return {
      axesLength: FALLBACK_GRID_SIZE / 2,
      center: [0, 0, 0],
      divisions: 10,
      size: FALLBACK_GRID_SIZE,
    };
  }

  const maxSpan = Math.max(...bounds.size, 1e-12);
  const maxGridSize = maxSpan * GRID_SIZE_UNIVERSE_LIMIT_SCALE;
  const targetCellSize = resolveViewport3DGridCellSize(maxGridSize);
  const divisions = Math.min(
    Math.max(1, Math.floor(maxGridSize / targetCellSize)),
    GRID_MAX_DIVISIONS,
  );
  const size = targetCellSize * divisions;

  return {
    axesLength: size / 2,
    center: bounds.center,
    divisions,
    size,
  };
}

function resolveViewport3DGridCellSize(maxGridSize: number): number {
  if (
    maxGridSize >= PREFERRED_GRID_CELL_SIZE * 4 &&
    maxGridSize <= PREFERRED_GRID_CELL_SIZE * GRID_MAX_DIVISIONS
  ) {
    return PREFERRED_GRID_CELL_SIZE;
  }

  if (maxGridSize > PREFERRED_GRID_CELL_SIZE * GRID_MAX_DIVISIONS) {
    return niceGridStep(maxGridSize / GRID_MAX_DIVISIONS);
  }

  return niceGridStep(maxGridSize / GRID_TARGET_DIVISIONS);
}

export function resolveViewport3DOrthographicZoom(
  bounds: Viewport3DBounds | null,
): number {
  const span = bounds
    ? Math.max(...bounds.size, bounds.radius * 2, 1e-12)
    : FALLBACK_GRID_SIZE;
  return clamp(2 / (span * 1.6), 1e-3, 1e12);
}

function niceGridStep(value: number): number {
  const exponent = Math.floor(Math.log10(Math.max(value, 1e-18)));
  const base = 10 ** exponent;
  const normalized = value / base;
  let multiplier = 10;
  if (normalized <= 1) {
    multiplier = 1;
  } else if (normalized <= 2) {
    multiplier = 2;
  } else if (normalized <= 5) {
    multiplier = 5;
  }
  return multiplier * base;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function Viewport3DScene({
  bounds,
  cameraProjection,
  cameraState,
  colors,
  airboxSettings,
  fdmDomain,
  femDomain,
  fieldModel,
  fitRevision,
  fallbackSettings,
  getObjectSettings,
  getPartSettings,
  magnetizationTexturePreviews,
  onCameraChange,
  onSelectObject,
  onSelectDomain,
  onSelectPart,
  primitiveModel,
  resetCameraRevision,
  resourceFrameKey,
  selectionBounds,
  tracker,
  topologyFreshness,
  topologyModel,
  vectorColorMode,
  vectorStyle,
  hslReferenceVisible,
  viewCubeVisible,
}: Viewport3DSceneProps) {
  const invalidate = useThree((state) => state.invalidate);
  const gridSpec = useMemo(() => resolveViewport3DGridSpec(bounds), [bounds]);
  const cameraFit = useMemo(() => resolveViewport3DCameraFit(bounds), [bounds]);
  const orthographicZoom = useMemo(
    () => resolveViewport3DOrthographicZoom(bounds),
    [bounds],
  );

  // Demand rendering needs an explicit frame when async resources settle.
  useEffect(() => {
    tracker.recordDirtyFrame("resources-updated");
    invalidate();
  }, [invalidate, resourceFrameKey, tracker]);

  return (
    <>
      <color attach="background" args={[colors.background]} />
      <ambientLight intensity={0.72} />
      <directionalLight intensity={0.9} position={[2, 3, 4]} />
      <CanvasLifecycleProbe tracker={tracker} />
      <CameraController
        bounds={bounds}
        cameraState={cameraState}
        fitRevision={fitRevision}
        onCameraChange={onCameraChange}
        resetCameraRevision={resetCameraRevision}
        tracker={tracker}
      />
      {cameraProjection === "orthographic" && (
        <OrthographicCamera
          makeDefault
          zoom={orthographicZoom}
          near={cameraFit.near}
          far={cameraFit.far}
          position={cameraState.position}
          up={VIEWPORT_3D_WORLD_UP}
        />
      )}
      <DomainBoxLayer
        bounds={bounds}
        boundsVisible={fallbackSettings.boundsVisible}
        colors={colors}
        onSelectDomain={onSelectDomain}
      />
      <FdmCuboidLayer
        colors={colors}
        domain={fdmDomain}
        onSelectDomain={onSelectDomain}
        settings={fallbackSettings}
        tracker={tracker}
      />
      <AirboxLayer
        colors={colors}
        fieldModel={fieldModel}
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
        magnetizationTexturePreviews={magnetizationTexturePreviews}
        onSelectDomain={onSelectDomain}
        onSelectPart={onSelectPart}
        tracker={tracker}
        topologyFreshness={topologyFreshness}
        topologyModel={topologyModel}
        vectorColorMode={vectorColorMode}
        vectorStyle={vectorStyle}
      />
      <SelectionHighlightLayer bounds={selectionBounds} colors={colors} />
      <group position={gridSpec.center}>
        <gridHelper
          args={[gridSpec.size, gridSpec.divisions, colors.wire, colors.wire]}
          rotation={[Math.PI / 2, 0, 0]}
        />
        <axesHelper args={[gridSpec.axesLength]} />
      </group>
      <OrbitCameraControls
        cameraState={cameraState}
        onCameraChange={onCameraChange}
        tracker={tracker}
      />
      <OrientationHudLayer
        colors={colors}
        hslReferenceVisible={hslReferenceVisible}
        viewCubeVisible={viewCubeVisible}
      />
    </>
  );
}
