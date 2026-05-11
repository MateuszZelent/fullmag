"use client";

import type {
  DecodedFieldVector,
  DecodedTopology,
} from "@/kernel/api/codecs";
import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

import type {
  FemManifestRenderDomain,
  Viewport3DMeshPart,
  Viewport3DPartSelection,
} from "../viewport3dDomainAdapter";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { Viewport3DBounds } from "../viewport3dRenderModel";
import type { Viewport3DCameraState } from "../viewport3dStore";
import type { Viewport3DColors } from "../viewport3dTypes";
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

interface Viewport3DSceneProps {
  bounds: Viewport3DBounds | null;
  cameraState: Viewport3DCameraState;
  colors: Viewport3DColors;
  airboxSettings: VisualizationTargetSettings;
  femDomain: FemManifestRenderDomain;
  fieldVector: DecodedFieldVector | null;
  fitRevision: number;
  getPartSettings: (part: Viewport3DMeshPart) => VisualizationTargetSettings;
  onSelectDomain: () => void;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  fallbackSettings: VisualizationTargetSettings;
  resetCameraRevision: number;
  selectionBounds: Viewport3DBounds | null;
  tracker: Viewport3DResourceTracker;
  topology: DecodedTopology | null;
  vectorScale: number;
}

export function Viewport3DScene({
  bounds,
  cameraState,
  colors,
  airboxSettings,
  femDomain,
  fieldVector,
  fitRevision,
  fallbackSettings,
  getPartSettings,
  onSelectDomain,
  onSelectPart,
  resetCameraRevision,
  selectionBounds,
  tracker,
  topology,
  vectorScale,
}: Viewport3DSceneProps) {
  return (
    <>
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
        femDomain={femDomain}
        fieldVector={fieldVector}
        settings={airboxSettings}
        topology={topology}
        tracker={tracker}
        vectorScale={vectorScale}
      />
      <TopologyMeshLayer
        colors={colors}
        fallbackSettings={fallbackSettings}
        femDomain={femDomain}
        fieldVector={fieldVector}
        getPartSettings={getPartSettings}
        onSelectDomain={onSelectDomain}
        onSelectPart={onSelectPart}
        tracker={tracker}
        topology={topology}
        vectorScale={vectorScale}
      />
      <SelectionHighlightLayer bounds={selectionBounds} colors={colors} />
      <gridHelper args={[2, 16, colors.wire, colors.wire]} />
      <axesHelper args={[1]} />
      <OrbitCameraControls tracker={tracker} />
    </>
  );
}
