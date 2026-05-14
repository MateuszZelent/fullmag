"use client";

import type { DecodedFieldVector } from "@/kernel/api/codecs";
import { OrthographicCamera } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import type { AxesHelper, GridHelper, Material } from "three";

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
import { Viewport3DLightingRig } from "./Viewport3DLightingRig";
import {
  getViewport3DVisualProfile,
  type Viewport3DVisualProfileId,
} from "../viewport3dVisualProfile";
import {
  resolveViewport3DMaterialProfile,
  type Viewport3DMaterialProfile,
} from "./viewport3DMaterialProfile";

interface Viewport3DSceneProps {
  bounds: Viewport3DBounds | null;
  cameraProjection: Viewport3DCameraProjection;
  cameraState: Viewport3DCameraState;
  colors: Viewport3DColors;
  airboxSettings: VisualizationTargetSettings;
  fdmDomain: FdmGridRenderDomain | null;
  fdmSettings: VisualizationTargetSettings;
  fdmSurfaceColors: ScalarColorBuffer | null;
  fieldVector: DecodedFieldVector | null | undefined;
  femDomain: FemManifestRenderDomain;
  fieldModel: Viewport3DFieldRenderModel | null;
  fitRevision: number;
  getObjectSettings: (object: Viewport3DPrimitiveObject) => VisualizationTargetSettings;
  getPartSettings: (part: Viewport3DMeshPart) => VisualizationTargetSettings;
  magnetizationTexturePreviews: Map<string, Viewport3DMagnetizationTexturePreview>;
  maxVectorGlyphs: number;
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
  vectorScale: number;
  vectorStyle: VectorFieldLayerVectorStyle;
  hslReferenceVisible: boolean;
  viewCubeVisible: boolean;
  visualProfileId: Viewport3DVisualProfileId;
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
  vectorScale,
  vectorStyle,
  hslReferenceVisible,
  viewCubeVisible,
  visualProfileId,
}: Viewport3DSceneProps) {
  const invalidate = useThree((state) => state.invalidate);
  const gridSpec = useMemo(() => resolveViewport3DGridSpec(bounds), [bounds]);
  const cameraFit = useMemo(() => resolveViewport3DCameraFit(bounds), [bounds]);
  const orthographicZoom = useMemo(
    () => resolveViewport3DOrthographicZoom(bounds),
    [bounds],
  );
  const materialProfile = useMemo(
    () =>
      resolveViewport3DMaterialProfile(
        getViewport3DVisualProfile(visualProfileId),
      ),
    [visualProfileId],
  );

  // Demand rendering needs an explicit frame when async resources settle.
  useEffect(() => {
    tracker.recordDirtyFrame("resources-updated");
    invalidate();
  }, [invalidate, resourceFrameKey, tracker]);

  return (
    <>
      <color attach="background" args={[colors.background]} />
      <Viewport3DLightingRig profileId={visualProfileId} />
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
        boundsVisible={fdmSettings.boundsVisible}
        colors={colors}
        onSelectDomain={onSelectDomain}
      />
      <FdmCuboidLayer
        colors={colors}
        domain={fdmDomain}
        fieldVector={fieldVector}
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
      <AxesGridLayer
        colors={colors}
        gridSpec={gridSpec}
        materialProfile={materialProfile}
      />
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

function AxesGridLayer({
  colors,
  gridSpec,
  materialProfile,
}: {
  colors: Viewport3DColors;
  gridSpec: Viewport3DGridSpec;
  materialProfile: Viewport3DMaterialProfile;
}) {
  const invalidate = useThree((state) => state.invalidate);
  const gridRef = useRef<GridHelper>(null);
  const axesRef = useRef<AxesHelper>(null);

  useEffect(() => {
    applyHelperMaterialProfile(gridRef.current?.material, materialProfile.grid);
    applyHelperMaterialProfile(axesRef.current?.material, materialProfile.axes);
    invalidate();
  }, [invalidate, materialProfile.axes, materialProfile.grid]);

  return (
    <group position={gridSpec.center}>
      <gridHelper
        args={[gridSpec.size, gridSpec.divisions, colors.wire, colors.wire]}
        ref={gridRef}
        rotation={[Math.PI / 2, 0, 0]}
      />
      <axesHelper args={[gridSpec.axesLength]} ref={axesRef} />
    </group>
  );
}

function applyHelperMaterialProfile(
  materialOrMaterials: Material | Material[] | undefined,
  profile: Viewport3DMaterialProfile["grid" | "axes"],
): void {
  const materials = Array.isArray(materialOrMaterials)
    ? materialOrMaterials
    : materialOrMaterials
      ? [materialOrMaterials]
      : [];
  for (const material of materials) {
    material.opacity = profile.opacity;
    material.transparent = profile.opacity < 1;
    material.depthTest = profile.depthTest;
    material.depthWrite = profile.depthWrite;
    material.toneMapped = profile.toneMapped;
    material.needsUpdate = true;
  }
}
