import type {
  FieldVectorQuery,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  DEFAULT_AIRBOX_VISUALIZATION,
  DEFAULT_OBJECT_VISUALIZATION,
  type VisualizationRenderMode,
  type VisualizationTargetRef,
  type VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";

import {
  resolveMeshPartBounds,
  type FemManifestRenderDomain,
  type Viewport3DMeshPart,
} from "../viewport3dDomainAdapter";
import type { Viewport3DBounds } from "../viewport3dRenderModel";

export const FULL_FIELD_QUERY: FieldVectorQuery = {
  component: "full",
  scope_kind: "full",
};

export const FALLBACK_OBJECT_VISUALIZATION: VisualizationTargetSettings =
  DEFAULT_OBJECT_VISUALIZATION;

export function resolveGlobalObjectVisualizationSettings(
  state: VisualizationStateResource | null | undefined,
): VisualizationTargetSettings {
  const surfaceVisible =
    state?.layers?.surface?.visible ?? DEFAULT_OBJECT_VISUALIZATION.shaderVisible;
  const wireframeVisible =
    state?.layers?.wireframe?.visible ??
    DEFAULT_OBJECT_VISUALIZATION.wireframeVisible;
  const pointsVisible =
    state?.layers?.points?.visible ?? DEFAULT_OBJECT_VISUALIZATION.pointsVisible;

  return {
    ...DEFAULT_OBJECT_VISUALIZATION,
    opacityPercent: layerOpacityToPercent(
      state?.layers?.surface?.opacity ??
        DEFAULT_OBJECT_VISUALIZATION.opacityPercent / 100,
    ),
    pointsVisible,
    renderMode: resolveRenderMode({
      pointsVisible,
      shaderVisible: surfaceVisible,
      wireframeVisible,
    }),
    shaderVisible: surfaceVisible,
    vectorsVisible:
      state?.layers?.vectors?.visible ??
      state?.vector_glyphs ??
      DEFAULT_OBJECT_VISUALIZATION.vectorsVisible,
    wireframeVisible,
  };
}

export function resolveAirboxBaseVisualizationSettings(
  state: VisualizationStateResource | null | undefined,
): VisualizationTargetSettings {
  const airbox = state?.layers?.airbox;
  const surfaceVisible =
    airbox?.surface?.visible ?? DEFAULT_AIRBOX_VISUALIZATION.shaderVisible;
  const wireframeVisible =
    airbox?.wireframe?.visible ?? DEFAULT_AIRBOX_VISUALIZATION.wireframeVisible;
  const pointsVisible =
    airbox?.points?.visible ?? DEFAULT_AIRBOX_VISUALIZATION.pointsVisible;

  return {
    ...DEFAULT_AIRBOX_VISUALIZATION,
    opacityPercent: layerOpacityToPercent(
      airbox?.opacity ?? DEFAULT_AIRBOX_VISUALIZATION.opacityPercent / 100,
    ),
    pointsVisible,
    renderMode: resolveRenderMode({
      pointsVisible,
      shaderVisible: surfaceVisible,
      wireframeVisible,
    }),
    shaderVisible: surfaceVisible,
    vectorsVisible:
      airbox?.vectors?.visible ?? DEFAULT_AIRBOX_VISUALIZATION.vectorsVisible,
    visible: airbox?.visible ?? DEFAULT_AIRBOX_VISUALIZATION.visible,
    wireframeVisible,
  };
}

export function targetForMeshPart(
  part: Viewport3DMeshPart,
): VisualizationTargetRef {
  if (part.object_id) {
    return {
      id: part.object_id,
      kind: "object",
      label: part.label,
    };
  }

  return {
    id: part.id,
    kind: "part",
    label: part.label,
  };
}

export function resolveViewport3DSelectionBounds(
  selection: Selection,
  domain: FemManifestRenderDomain,
  fallbackBounds: Viewport3DBounds | null,
): Viewport3DBounds | null {
  if (!selection.kind) return null;

  return (
    resolveMeshPartBounds(
      selection.nodeId ? domain.partsById.get(selection.nodeId) : null,
    ) ??
    resolveObjectBounds(domain, selection.objectId) ??
    (selection.kind === "airbox.visualization" ||
    selection.kind === "mesh-part-airbox"
      ? resolveAirboxBounds(domain)
      : fallbackBounds)
  );
}

function resolveAirboxBounds(
  domain: FemManifestRenderDomain,
): Viewport3DBounds | null {
  return combineBounds(domain.airboxParts.map(resolveMeshPartBounds));
}

function resolveObjectBounds(
  domain: FemManifestRenderDomain,
  objectId: string | null,
): Viewport3DBounds | null {
  if (!objectId) return null;
  const partIds = domain.objectPartIds.get(objectId) ?? [];
  return combineBounds(
    partIds.map((partId) => resolveMeshPartBounds(domain.partsById.get(partId))),
  );
}

function combineBounds(
  boundsList: Array<Viewport3DBounds | null>,
): Viewport3DBounds | null {
  const validBounds = boundsList.filter(
    (entry): entry is Viewport3DBounds => Boolean(entry),
  );
  if (!validBounds.length) return null;

  const min = validBounds.reduce<[number, number, number]>(
    (current, bounds) => [
      Math.min(current[0], bounds.center[0] - bounds.size[0] / 2),
      Math.min(current[1], bounds.center[1] - bounds.size[1] / 2),
      Math.min(current[2], bounds.center[2] - bounds.size[2] / 2),
    ],
    [Infinity, Infinity, Infinity],
  );
  const max = validBounds.reduce<[number, number, number]>(
    (current, bounds) => [
      Math.max(current[0], bounds.center[0] + bounds.size[0] / 2),
      Math.max(current[1], bounds.center[1] + bounds.size[1] / 2),
      Math.max(current[2], bounds.center[2] + bounds.size[2] / 2),
    ],
    [-Infinity, -Infinity, -Infinity],
  );
  const size: [number, number, number] = [
    Math.max(max[0] - min[0], 0),
    Math.max(max[1] - min[1], 0),
    Math.max(max[2] - min[2], 0),
  ];

  return {
    center: [
      min[0] + size[0] / 2,
      min[1] + size[1] / 2,
      min[2] + size[2] / 2,
    ],
    radius: Math.max(Math.hypot(size[0], size[1], size[2]) / 2, 1e-12),
    size,
  };
}

function resolveRenderMode({
  pointsVisible,
  shaderVisible,
  wireframeVisible,
}: {
  pointsVisible: boolean;
  shaderVisible: boolean;
  wireframeVisible: boolean;
}): VisualizationRenderMode {
  if (pointsVisible && !shaderVisible && !wireframeVisible) return "points";
  if (!shaderVisible && wireframeVisible) return "wireframe";
  if (shaderVisible && wireframeVisible) return "surface+edges";
  return "surface";
}

function layerOpacityToPercent(opacity: number): number {
  return Math.round(Math.max(0, Math.min(1, opacity)) * 100);
}
