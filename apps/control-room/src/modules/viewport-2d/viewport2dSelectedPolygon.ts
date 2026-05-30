import type { Selection } from "@/kernel/selection/selectionTypes";

import type {
  Viewport2DPolygonSummary,
  Viewport2DRenderModel,
} from "./viewport2dRenderModel";

export function resolveViewport2DSelectedPolygon(
  model: Viewport2DRenderModel,
  selection: Pick<Selection, "ref">,
): Viewport2DPolygonSummary | null {
  if (selection.ref?.type !== "mesh-quality-element") return null;
  const elementIndex = selection.ref.elementIndex;

  return (
    model.polygons.find(
      (polygon) =>
        polygon.visible &&
        polygon.parentElementId === elementIndex,
    ) ?? null
  );
}
