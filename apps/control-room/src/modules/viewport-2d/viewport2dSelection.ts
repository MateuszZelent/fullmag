import type { CrossSectionQualityMetric } from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

import type { Viewport2DPolygonSummary } from "./viewport2dRenderModel";

export function resolveViewport2DPolygonSelection(
  polygon: Viewport2DPolygonSummary,
  metric: CrossSectionQualityMetric,
): Partial<Omit<Selection, "moduleSource">> {
  const nodeId = `model:mesh:quality:cross-section:${polygon.parentElementId}`;
  return {
    kind: "mesh.cross-section",
    label: `Cross-section parent tet ${polygon.parentElementId}`,
    nodeId,
    objectId: null,
    ref: {
      centroid: polygon.worldCentroid,
      elementIndex: polygon.parentElementId,
      kind: "mesh.quality.element",
      metric,
      nodeId,
      type: "mesh-quality-element",
      visualizationTargetId: `mesh:quality:element:${polygon.parentElementId}`,
    },
  };
}
