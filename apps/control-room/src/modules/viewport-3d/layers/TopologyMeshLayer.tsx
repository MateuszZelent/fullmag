"use client";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

import type {
  FemManifestRenderDomain,
  Viewport3DMeshPart,
  Viewport3DPartSelection,
} from "../viewport3dDomainAdapter";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { Viewport3DMagnetizationTexturePreview } from "../viewport3dPrimitiveModel";
import {
  isViewport3DTopologyCurrent,
  resolveStaleTopologyVisualizationSettings,
  type Viewport3DTopologyFreshness,
} from "../viewport3dTopologyStaleness";
import type {
  Viewport3DFieldRenderModel,
  Viewport3DTopologyRenderModel,
} from "../viewport3dRenderModel";
import type { Viewport3DColors } from "../viewport3dTypes";
import { FallbackTopologyMeshLayer } from "./FallbackTopologyMeshLayer";
import { MeshPartLayer } from "./MeshPartLayer";
import type { Viewport3DMaterialProfile } from "./viewport3DMaterialProfile";
import type { VectorFieldLayerVectorStyle } from "./VectorFieldLayer";

export function TopologyMeshLayer({
  colors,
  vectorColorMode,
  fallbackSettings,
  femDomain,
  fieldModel,
  getPartSettings,
  materialProfile,
  magnetizationTexturePreviews,
  onSelectDomain,
  onSelectPart,
  tracker,
  topologyModel,
  topologyFreshness,
  vectorStyle,
}: {
  colors: Viewport3DColors;
  vectorColorMode: string;
  fallbackSettings: VisualizationTargetSettings;
  femDomain: FemManifestRenderDomain;
  fieldModel: Viewport3DFieldRenderModel | null;
  getPartSettings: (part: Viewport3DMeshPart) => VisualizationTargetSettings;
  materialProfile: Viewport3DMaterialProfile;
  magnetizationTexturePreviews: Map<string, Viewport3DMagnetizationTexturePreview>;
  onSelectDomain: () => void;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  tracker: Viewport3DResourceTracker;
  topologyModel: Viewport3DTopologyRenderModel<Viewport3DMeshPart> | null;
  topologyFreshness: Viewport3DTopologyFreshness;
  vectorStyle: VectorFieldLayerVectorStyle;
}) {
  const topologyCurrent = isViewport3DTopologyCurrent(topologyFreshness);
  const resolvedFieldModel = topologyCurrent ? fieldModel : null;

  if (topologyModel?.magneticParts.length) {
    return (
      <>
        {topologyModel.magneticParts.map((partModel) => {
          const settings = getPartSettings(partModel.part);
          return (
            <MeshPartLayer
              colors={colors}
              fieldModel={resolvedFieldModel}
              key={partModel.part.id}
              magnetizationTexturePreview={
                partModel.part.object_id
                  ? (magnetizationTexturePreviews.get(partModel.part.object_id) ?? null)
                  : null
              }
              materialProfile={materialProfile}
              onSelectPart={onSelectPart}
              partModel={partModel}
              settings={
                topologyCurrent
                  ? settings
                  : resolveStaleTopologyVisualizationSettings(settings)
              }
              topologyModel={topologyModel}
              tracker={tracker}
              vectorColorMode={vectorColorMode}
              vectorStyle={vectorStyle}
            />
          );
        })}
      </>
    );
  }

  return (
    <FallbackTopologyMeshLayer
      colors={colors}
      fallbackSettings={
        topologyCurrent
          ? fallbackSettings
          : resolveStaleTopologyVisualizationSettings(fallbackSettings)
      }
      femDomain={femDomain}
      fieldModel={resolvedFieldModel}
      materialProfile={materialProfile}
      onSelectDomain={onSelectDomain}
      onSelectPart={onSelectPart}
      topologyModel={topologyModel}
      tracker={tracker}
      vectorColorMode={vectorColorMode}
      vectorStyle={vectorStyle}
    />
  );
}
