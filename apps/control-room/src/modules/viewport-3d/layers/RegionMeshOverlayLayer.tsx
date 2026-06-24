"use client";

import type { ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry } from "three";

import type { DecodedTopology } from "@/kernel/api/codecs";
import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import {
  type RegionMeshOverlayModel,
  type RegionMeshOverlayOwnerPart,
  type RegionOverlayInput,
  type RegionOverlayTheme,
} from "./regionOverlayModel";
import { buildViewport3DRegionOverlayModels } from "../region-overlays/viewport3dRegionOverlayBuildModel";
import { materialPolicyProps, RENDER_POLICIES } from "./viewport3DRenderPolicy";
import type { RegionOverlaySelection } from "./RegionOverlayLayer";

export interface RegionMeshOverlayLayerProps {
  getRegionSettings?: (region: RegionOverlayInput) => VisualizationTargetSettings;
  magneticParts: readonly RegionMeshOverlayOwnerPart[];
  onSelectRegion?: (selection: RegionOverlaySelection) => void;
  renderedSurfacePartIds?: ReadonlySet<string>;
  regions: readonly RegionOverlayInput[];
  selectedObjectId?: string | null;
  selectedRegionId?: string | null;
  theme?: RegionOverlayTheme;
  topology: DecodedTopology | null | undefined;
  tracker: Viewport3DResourceTracker;
  visible?: boolean;
}

const CSS_VARIABLE_COLOR_PATTERN = /^var\((--[-_a-zA-Z0-9]+)\)$/;

function resolveCssColorToken(color: string): string {
  const match = CSS_VARIABLE_COLOR_PATTERN.exec(color.trim());
  if (!match || typeof document === "undefined") return color;

  const resolved = getComputedStyle(document.documentElement)
    .getPropertyValue(match[1])
    .trim();
  return resolved || color;
}

export function RegionMeshOverlayLayer({
  getRegionSettings,
  magneticParts,
  onSelectRegion,
  renderedSurfacePartIds,
  regions,
  selectedObjectId = null,
  selectedRegionId = null,
  theme = "mocha",
  topology,
  tracker,
  visible = true,
}: RegionMeshOverlayLayerProps) {
  const models = useMemo(
    () => {
      if (!topology) return [];
      return buildViewport3DRegionOverlayModels({
        magneticParts,
        regions,
        renderedSurfacePartIds: renderedSurfacePartIds
          ? [...renderedSurfacePartIds].toSorted()
          : undefined,
        selectedObjectId,
        selectedRegionId,
        settingsByRegionId: getRegionSettings
          ? resolveRegionSettingsEntries(regions, getRegionSettings)
          : undefined,
        theme,
        topology,
      }).models;
    },
    [
      getRegionSettings,
      magneticParts,
      renderedSurfacePartIds,
      regions,
      selectedObjectId,
      selectedRegionId,
      theme,
      topology,
    ],
  );

  if (!visible || models.length === 0) return null;

  return (
    <group name="region-mesh-overlays">
      {models.map((model) => (
        <RegionMeshOverlayShape
          key={model.regionId}
          model={model}
          onSelectRegion={onSelectRegion}
          tracker={tracker}
        />
      ))}
    </group>
  );
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

function RegionMeshOverlayShape({
  model,
  onSelectRegion,
  tracker,
}: {
  model: RegionMeshOverlayModel;
  onSelectRegion?: (selection: RegionOverlaySelection) => void;
  tracker: Viewport3DResourceTracker;
}) {
  const invalidate = useBatchedInvalidate();
  const surfaceGeometry = useMemo(() => {
    if (!model.surfaceIndices?.length || !model.style.fillVisible) return null;
    const next = new BufferGeometry();
    next.setAttribute("position", new BufferAttribute(model.positions, 3));
    next.setIndex(new BufferAttribute(model.surfaceIndices, 1));
    return tracker.track("geometry", next);
  }, [model, tracker]);
  const edgeGeometry = useMemo(() => {
    const indices = model.surfaceEdgeIndices ?? model.edgeIndices;
    if (!indices?.length || !model.style.wireframeVisible) return null;
    const next = new BufferGeometry();
    next.setAttribute("position", new BufferAttribute(model.positions, 3));
    next.setIndex(new BufferAttribute(indices, 1));
    return tracker.track("geometry", next);
  }, [model, tracker]);

  useEffect(
    () => () => tracker.release("geometry", surfaceGeometry),
    [surfaceGeometry, tracker],
  );
  useEffect(
    () => () => tracker.release("geometry", edgeGeometry),
    [edgeGeometry, tracker],
  );
  useEffect(() => {
    if (!surfaceGeometry && !edgeGeometry) return;
    tracker.recordDirtyFrame("region-mesh-overlay");
    invalidate();
  }, [edgeGeometry, invalidate, surfaceGeometry, tracker]);

  if (!surfaceGeometry && !edgeGeometry) return null;

  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onSelectRegion?.({ objectId: model.objectId, regionId: model.regionId });
  };
  const selectRegionFromClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    onSelectRegion?.({ objectId: model.objectId, regionId: model.regionId });
  };
  const fillColor = resolveCssColorToken(model.style.surfaceColor ?? model.color);
  const wireframeColor = resolveCssColorToken(
    model.style.wireframeColor ?? model.color,
  );

  return (
    <group
      name={`region-mesh-overlay:${model.regionId}`}
      onClick={selectRegionFromClick}
      onPointerDown={handlePointerDown}
    >
      {surfaceGeometry ? (
        <mesh
          geometry={surfaceGeometry}
          renderOrder={RENDER_POLICIES.selectionShell.renderOrder}
        >
          <meshBasicMaterial
            color={fillColor}
            colorWrite={model.surfaceOverlayVisible}
            opacity={model.surfaceOverlayVisible ? model.style.fillOpacity : 0}
            {...materialPolicyProps("selectionShell")}
            depthWrite={
              model.surfaceOverlayVisible && model.style.fillOpacity >= 1
            }
            transparent={!model.surfaceOverlayVisible || model.style.fillOpacity < 1}
          />
        </mesh>
      ) : null}
      {edgeGeometry ? (
        <lineSegments
          geometry={edgeGeometry}
          renderOrder={RENDER_POLICIES.featureEdges.renderOrder + 1}
        >
          <lineBasicMaterial
            color={wireframeColor}
            opacity={model.style.wireframeOpacity}
            {...materialPolicyProps("featureEdges")}
          />
        </lineSegments>
      ) : null}
    </group>
  );
}
