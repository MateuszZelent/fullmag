"use client";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

import type {
  FemManifestRenderDomain,
  Viewport3DMeshPart,
  Viewport3DPartSelection,
} from "../viewport3dDomainAdapter";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { Viewport3DMagnetizationTexturePreview } from "../viewport3dPrimitiveModel";
import type {
  Viewport3DFieldRenderModel,
  Viewport3DTopologyRenderModel,
} from "../viewport3dRenderModel";
import type { Viewport3DColors } from "../viewport3dTypes";
import { FallbackTopologyMeshLayer } from "./FallbackTopologyMeshLayer";
import { MeshPartLayer } from "./MeshPartLayer";
import type { VectorFieldLayerVectorStyle } from "./VectorFieldLayer";

export function TopologyMeshLayer({
  colors,
  vectorColorMode,
  fallbackSettings,
  femDomain,
  fieldModel,
  getPartSettings,
  magnetizationTexturePreviews,
  onSelectDomain,
  onSelectPart,
  tracker,
  topologyModel,
  vectorStyle,
}: {
  colors: Viewport3DColors;
  vectorColorMode: string;
  fallbackSettings: VisualizationTargetSettings;
  femDomain: FemManifestRenderDomain;
  fieldModel: Viewport3DFieldRenderModel | null;
  getPartSettings: (part: Viewport3DMeshPart) => VisualizationTargetSettings;
  magnetizationTexturePreviews: Map<string, Viewport3DMagnetizationTexturePreview>;
  onSelectDomain: () => void;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  tracker: Viewport3DResourceTracker;
  topologyModel: Viewport3DTopologyRenderModel<Viewport3DMeshPart> | null;
  vectorStyle: VectorFieldLayerVectorStyle;
}) {
  if (topologyModel?.magneticParts.length) {
    return (
      <>
        {topologyModel.magneticParts.map((partModel) => (
          <MeshPartLayer
            colors={colors}
            fieldModel={fieldModel}
            key={partModel.part.id}
            magnetizationTexturePreview={
              partModel.part.object_id
                ? (magnetizationTexturePreviews.get(partModel.part.object_id) ?? null)
                : null
            }
            onSelectPart={onSelectPart}
            partModel={partModel}
            settings={getPartSettings(partModel.part)}
            topologyModel={topologyModel}
            tracker={tracker}
            vectorColorMode={vectorColorMode}
            vectorStyle={vectorStyle}
          />
        ))}
      </>
    );
  }

  return (
    <FallbackTopologyMeshLayer
      colors={colors}
      fallbackSettings={fallbackSettings}
      femDomain={femDomain}
      fieldModel={fieldModel}
      onSelectDomain={onSelectDomain}
      onSelectPart={onSelectPart}
      topologyModel={topologyModel}
      tracker={tracker}
      vectorColorMode={vectorColorMode}
      vectorStyle={vectorStyle}
    />
  );
}
