import type { Viewport3DBounds, Viewport3DFieldRenderModel, Viewport3DTopologyPartRenderModel } from "../viewport3dRenderModel";
import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";
import { type Viewport3DMeshPart } from "../viewport3dDomainAdapter";
import type { ColorRepresentation } from "three";
import { percentToUnit, shaderUsesVertexColors, surfaceMaterialColorFromSettings, surfaceScalarColorModeFromSettings } from "./viewport3DLayerSettings";
import type { ScalarColorBuffer } from "../viewport3dFieldMapping";
import { resolveViewport3DTargetSurfaceLayerInput } from "./viewport3DLayerPassInputs";
import { canApplyVertexScalarColorBuffer } from "../viewport3dGeometryColors";
import { isViewport3DTopologyCurrent, resolveUnavailableTopologyVisualizationSettings, type Viewport3DTopologyFreshness } from "../viewport3dTopologyStaleness";
import type { Viewport3DMaterialProfile } from "./viewport3DMaterialProfile";
import { type RenderSemantic } from "./viewport3DRenderPolicy";
import { resolveMeshPartSurfacePickIdentity } from "./MeshPartLayer.model";

export interface AirboxSurfaceColorState {
  hasScalarColors: boolean;
  materialColor: ColorRepresentation;
  scalarColors: ScalarColorBuffer | null;
  vertexColorsEnabled: boolean;
}

export function resolveAirboxMeshPartSurfacePickIdentity(
  input: Parameters<typeof resolveMeshPartSurfacePickIdentity>[0],
) {
  return resolveMeshPartSurfacePickIdentity(input);
}

export function resolveAirboxWireframeSemantic(
  settings: VisualizationTargetSettings,
): Extract<RenderSemantic, "featureEdges" | "hiddenEdges"> {
  if (settings.geometryScope === "full") return "hiddenEdges";
  return settings.shaderVisible ? "featureEdges" : "hiddenEdges";
}

export function airboxWireframeOpacityFromSettings(
  settings: VisualizationTargetSettings,
  featureEdges?: Viewport3DMaterialProfile["featureEdges"],
): number {
  const opacity =
    percentToUnit(settings.wireframeOpacityPercent) *
    (featureEdges?.opacity ?? 1);
  return Math.max(0, Math.min(1, opacity));
}

export function resolveAirboxWireframePrimitive(
  wireframeVisible: boolean,
  hasEdgeGeometry: boolean,
  geometryScope: VisualizationTargetSettings["geometryScope"] = "surface",
): "bounds" | "lines" | null {
  if (!wireframeVisible) return null;
  if (geometryScope === "full" && hasEdgeGeometry) return "lines";
  return hasEdgeGeometry ? "lines" : "bounds";
}

export function resolvePartNodeIndices(
  part: {
    node_start?: number;
    nodeStart?: number;
    node_count?: number;
    nodeCount?: number;
    node_indices?: readonly number[];
    nodeIndices?: readonly number[];
  },
  nodeCount: number,
): Uint32Array {
  const indices = part.node_indices ?? part.nodeIndices;
  if (indices?.length) {
    return new Uint32Array(indices);
  }
  const start = Math.max(0, Math.floor(part.node_start ?? part.nodeStart ?? 0));
  const rawCount = part.node_count ?? part.nodeCount;
  const count =
    rawCount === undefined || (rawCount <= 0 && start > 0)
      ? nodeCount - start
      : Math.max(0, Math.floor(rawCount));
  if (count <= 0 || start >= nodeCount) return new Uint32Array();

  const end = Math.min(nodeCount, start + count);
  const result = new Uint32Array(end - start);
  for (let i = 0; i < result.length; i += 1) {
    result[i] = start + i;
  }
  return result;
}

export function getUniqueSortedIndices(indices: Uint32Array): Uint32Array {
  const unique = new Set<number>();
  for (let index = 0; index < indices.length; index += 1) {
    unique.add(indices[index] ?? 0);
  }
  return new Uint32Array(Array.from(unique).sort((left, right) => left - right));
}

export function resolveAirboxTopologyVisualizationSettings(
  settings: VisualizationTargetSettings,
  topologyFreshness: Viewport3DTopologyFreshness,
): VisualizationTargetSettings {
  const runtimeSettings = resolveAirboxRuntimeVisualizationSettings(settings);
  if (isViewport3DTopologyCurrent(topologyFreshness)) {
    return runtimeSettings;
  }

  return {
    ...resolveUnavailableTopologyVisualizationSettings(runtimeSettings),
    geometryScope: runtimeSettings.geometryScope,
  };
}

export function resolveAirboxRuntimeVisualizationSettings(
  settings: VisualizationTargetSettings,
): VisualizationTargetSettings {
  const renderMode = settings.pointsVisible
    ? "points"
    : settings.wireframeVisible
      ? "wireframe"
      : "off";
  if (
    !settings.shaderVisible &&
    settings.surfaceColorSource === "solid" &&
    !settings.viewportColorbarVisible &&
    settings.renderMode === renderMode
  ) {
    return settings;
  }
  return {
    ...settings,
    renderMode,
    shaderVisible: false,
    surfaceColorSource: "solid",
    viewportColorbarVisible: false,
  };
}

export function resolveAirboxSurfaceColorState(
  settings: VisualizationTargetSettings,
  fieldModel: (
    Pick<Viewport3DFieldRenderModel, "scalarColorsByMode"> &
      Partial<Pick<Viewport3DFieldRenderModel, "targetPasses">>
  ) | null,
  partId: string,
  nodeCount: number,
  fallbackColor: ColorRepresentation,
): AirboxSurfaceColorState {
  const scalarColorMode = surfaceScalarColorModeFromSettings(settings);
  const scalarColors: ScalarColorBuffer | null =
    resolveViewport3DTargetSurfaceLayerInput({
      fieldModel,
      partId,
      scalarColorMode,
    }).scalarColors;
  const vertexColorsEnabled = shaderUsesVertexColors(settings);
  const hasScalarColors =
    vertexColorsEnabled &&
    canApplyVertexScalarColorBuffer(scalarColors, nodeCount);

  return {
    hasScalarColors,
    materialColor: surfaceMaterialColorFromSettings(
      settings,
      fallbackColor,
      hasScalarColors,
    ),
    scalarColors,
    vertexColorsEnabled,
  };
}

export function resolveAirboxWireframeEdgeIndices(
  geometryScope: VisualizationTargetSettings["geometryScope"],
  partModel: Pick<
    Viewport3DTopologyPartRenderModel<Viewport3DMeshPart>,
    "edgeIndices" | "volumeEdgeIndices"
  >,
  wireframeVisible = true,
): Uint32Array | null {
  if (!wireframeVisible) return null;
  if (geometryScope === "full") {
    return partModel.volumeEdgeIndices;
  }

  return partModel.edgeIndices;
}

const AIRBOX_VOLUME_WIREFRAME_DIVISIONS = 4;

export function buildBoundsVolumeWireframePositions(
  bounds: Viewport3DBounds | null,
  divisions = AIRBOX_VOLUME_WIREFRAME_DIVISIONS,
): Float32Array | null {
  if (!bounds) return null;

  const safeDivisions = Math.max(1, Math.floor(divisions));
  const [cx, cy, cz] = bounds.center;
  const [sx, sy, sz] = bounds.size.map((value) => Math.max(value, 1e-9)) as [
    number,
    number,
    number,
  ];
  const min: [number, number, number] = [
    cx - sx / 2,
    cy - sy / 2,
    cz - sz / 2,
  ];
  const max: [number, number, number] = [
    cx + sx / 2,
    cy + sy / 2,
    cz + sz / 2,
  ];
  const positions: number[] = [];

  for (let ix = 0; ix <= safeDivisions; ix += 1) {
    const x = lerp(min[0], max[0], ix / safeDivisions);
    for (let iy = 0; iy <= safeDivisions; iy += 1) {
      const y = lerp(min[1], max[1], iy / safeDivisions);
      appendLine(positions, [x, y, min[2]], [x, y, max[2]]);
    }
    for (let iz = 0; iz <= safeDivisions; iz += 1) {
      const z = lerp(min[2], max[2], iz / safeDivisions);
      appendLine(positions, [x, min[1], z], [x, max[1], z]);
    }
  }

  for (let iy = 0; iy <= safeDivisions; iy += 1) {
    const y = lerp(min[1], max[1], iy / safeDivisions);
    for (let iz = 0; iz <= safeDivisions; iz += 1) {
      const z = lerp(min[2], max[2], iz / safeDivisions);
      appendLine(positions, [min[0], y, z], [max[0], y, z]);
    }
  }

  return new Float32Array(positions);
}

function appendLine(
  positions: number[],
  start: [number, number, number],
  end: [number, number, number],
): void {
  positions.push(start[0], start[1], start[2], end[0], end[1], end[2]);
}

function lerp(start: number, end: number, factor: number): number {
  return start + (end - start) * factor;
}
