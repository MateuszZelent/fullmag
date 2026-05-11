"use client";

import { useThree } from "@react-three/fiber";
import { useEffect } from "react";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

import type {
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
import type {
  Viewport3DPrimitiveObject,
  Viewport3DPrimitiveRenderModel,
} from "../viewport3dPrimitiveModel";
import type { Viewport3DCameraState } from "../viewport3dStore";
import type { Viewport3DColors } from "../viewport3dTypes";
import { OrientationHudLayer } from "../orientation/OrientationHudLayer";
import {
  CameraController,
  OrbitCameraControls,
} from "./CameraControls";
import { CanvasLifecycleProbe } from "./CanvasLifecycleProbe";
import {
  AirboxLayer,
  DomainBoxLayer,
  SelectionHighlightLayer,
} from "./BoundsLayers";
import { TopologyMeshLayer } from "./TopologyMeshLayer";
import { PrimitiveObjectLayer } from "./PrimitiveObjectLayer";

interface Viewport3DSceneProps {
  bounds: Viewport3DBounds | null;
  cameraState: Viewport3DCameraState;
  colors: Viewport3DColors;
  airboxSettings: VisualizationTargetSettings;
  femDomain: FemManifestRenderDomain;
  fieldModel: Viewport3DFieldRenderModel | null;
  fitRevision: number;
  getObjectSettings: (object: Viewport3DPrimitiveObject) => VisualizationTargetSettings;
  getPartSettings: (part: Viewport3DMeshPart) => VisualizationTargetSettings;
  onSelectObject: (object: Viewport3DPrimitiveObject) => void;
  onSelectDomain: () => void;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  fallbackSettings: VisualizationTargetSettings;
  primitiveModel: Viewport3DPrimitiveRenderModel | null;
  resetCameraRevision: number;
  selectionBounds: Viewport3DBounds | null;
  tracker: Viewport3DResourceTracker;
  topologyModel: Viewport3DTopologyRenderModel<Viewport3DMeshPart> | null;
  vectorColorMode: string;
  hslReferenceVisible: boolean;
  viewCubeVisible: boolean;
}

export function Viewport3DScene({
  bounds,
  cameraState,
  colors,
  airboxSettings,
  femDomain,
  fieldModel,
  fitRevision,
  fallbackSettings,
  getObjectSettings,
  getPartSettings,
  onSelectObject,
  onSelectDomain,
  onSelectPart,
  primitiveModel,
  resetCameraRevision,
  selectionBounds,
  tracker,
  topologyModel,
  vectorColorMode,
  hslReferenceVisible,
  viewCubeVisible,
}: Viewport3DSceneProps) {
  const invalidate = useThree((state) => state.invalidate);

  // Guarantee the demand frameloop draws at least one frame on mount.
  // CameraController also calls invalidate, but it can race with R3F init.
  useEffect(() => {
    invalidate();
  }, [invalidate]);

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
        resetCameraRevision={resetCameraRevision}
        tracker={tracker}
      />
      <DomainBoxLayer
        bounds={bounds}
        colors={colors}
        onSelectDomain={onSelectDomain}
      />
      <AirboxLayer
        colors={colors}
        fieldModel={fieldModel}
        onSelectPart={onSelectPart}
        settings={airboxSettings}
        topologyModel={topologyModel}
        tracker={tracker}
        vectorColorMode={vectorColorMode}
      />
      <PrimitiveObjectLayer
        colors={colors}
        getObjectSettings={getObjectSettings}
        onSelectObject={onSelectObject}
        primitiveModel={primitiveModel}
      />
      <TopologyMeshLayer
        colors={colors}
        fallbackSettings={fallbackSettings}
        femDomain={femDomain}
        fieldModel={fieldModel}
        getPartSettings={getPartSettings}
        onSelectDomain={onSelectDomain}
        onSelectPart={onSelectPart}
        tracker={tracker}
        topologyModel={topologyModel}
        vectorColorMode={vectorColorMode}
      />
      <SelectionHighlightLayer bounds={selectionBounds} colors={colors} />
      <gridHelper args={[2, 16, colors.wire, colors.wire]} />
      <axesHelper args={[1]} />
      <OrbitCameraControls tracker={tracker} />
      <OrientationHudLayer
        colors={colors}
        hslReferenceVisible={hslReferenceVisible}
        viewCubeVisible={viewCubeVisible}
      />
    </>
  );
}
