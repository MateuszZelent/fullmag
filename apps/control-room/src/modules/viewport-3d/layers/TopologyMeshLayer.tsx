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
  resolveUnavailableTopologyVisualizationSettings,
  type Viewport3DTopologyFreshness,
} from "../viewport3dTopologyStaleness";
import type {
  Viewport3DFieldRenderModel,
  Viewport3DTopologyRenderModel,
} from "../viewport3dRenderModel";
import type { ScalarColorBuffer } from "../viewport3dFieldMapping";
import type { Viewport3DColors } from "../viewport3dTypes";
import { FallbackTopologyMeshLayer } from "./FallbackTopologyMeshLayer";
import { MeshPartLayer } from "./MeshPartLayer";
import type { Viewport3DMaterialProfile } from "./viewport3DMaterialProfile";
import type { VectorFieldLayerVectorStyle } from "./VectorFieldLayer";
import type { Viewport3DRenderAdoptionRegistry } from "../model/viewport3DRenderAdoptionRegistry";

export function TopologyMeshLayer({
  adoptionRegistry,
  colors,
  vectorColorMode,
  fallbackSettings,
  femDomain,
  fieldModel,
  getPartSettings,
  materialProfile,
  magnetizationTexturePreviews,
  meshQualityColors,
  meshQualityOverlayVisible,
  onSelectDomain,
  onSelectPart,
  tracker,
  topologyModel,
  topologyFreshness,
  vectorStyle,
}: {
  adoptionRegistry?: Viewport3DRenderAdoptionRegistry;
  colors: Viewport3DColors;
  vectorColorMode: string;
  fallbackSettings: VisualizationTargetSettings;
  femDomain: FemManifestRenderDomain;
  fieldModel: Viewport3DFieldRenderModel | null;
  getPartSettings: (part: Viewport3DMeshPart) => VisualizationTargetSettings;
  materialProfile: Viewport3DMaterialProfile;
  magnetizationTexturePreviews: Map<string, Viewport3DMagnetizationTexturePreview>;
  meshQualityColors: ScalarColorBuffer | null;
  meshQualityOverlayVisible: boolean;
  onSelectDomain: () => void;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  tracker: Viewport3DResourceTracker;
  topologyModel: Viewport3DTopologyRenderModel<Viewport3DMeshPart> | null;
  topologyFreshness: Viewport3DTopologyFreshness;
  vectorStyle: VectorFieldLayerVectorStyle;
}) {
  const topologyCurrent = isViewport3DTopologyCurrent(topologyFreshness);
  const resolvedFieldModel = topologyCurrent
    ? fieldModel
    : null;

  if (topologyModel?.magneticParts.length) {
    return (
      <>
        {topologyModel.magneticParts.map((partModel) => {
          const settings = getPartSettings(partModel.part);
          return (
            <MeshPartLayer
              adoptionRegistry={adoptionRegistry}
              colors={colors}
              fieldModel={resolvedFieldModel}
              key={partModel.part.id}
              magnetizationTexturePreview={(() => {
                const objectId = partModel.part.object_id;
                const geometryId = partModel.part.geometry_id;
                if (objectId) {
                  const direct = magnetizationTexturePreviews.get(objectId);
                  if (direct) return direct;
                  const withGeom = magnetizationTexturePreviews.get(`${objectId}_geom`);
                  if (withGeom) return withGeom;
                  if (objectId.endsWith("_geom")) {
                    const withoutGeom = magnetizationTexturePreviews.get(objectId.slice(0, -5));
                    if (withoutGeom) return withoutGeom;
                  }
                }
                if (geometryId) {
                  const direct = magnetizationTexturePreviews.get(geometryId);
                  if (direct) return direct;
                  const withGeom = magnetizationTexturePreviews.get(`${geometryId}_geom`);
                  if (withGeom) return withGeom;
                  if (geometryId.endsWith("_geom")) {
                    const withoutGeom = magnetizationTexturePreviews.get(geometryId.slice(0, -5));
                    if (withoutGeom) return withoutGeom;
                  }
                }
                return null;
              })()}
              materialProfile={materialProfile}
              meshQualityColors={meshQualityOverlayVisible ? meshQualityColors : null}
              onSelectPart={onSelectPart}
              partModel={partModel}
              settings={
                topologyCurrent
                  ? settings
                  : resolveUnavailableTopologyVisualizationSettings(settings)
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
          : resolveUnavailableTopologyVisualizationSettings(fallbackSettings)
      }
      femDomain={femDomain}
      fieldModel={resolvedFieldModel}
      materialProfile={materialProfile}
      meshQualityColors={meshQualityOverlayVisible ? meshQualityColors : null}
      onSelectDomain={onSelectDomain}
      onSelectPart={onSelectPart}
      topologyModel={topologyModel}
      tracker={tracker}
      vectorColorMode={vectorColorMode}
      vectorStyle={vectorStyle}
    />
  );
}
