import type { Viewport2DLoadState } from "./viewport2dLoadState";
import type { Viewport2DPolygonSummary } from "./viewport2dRenderModel";

export function viewport2dHudText(
  state: Viewport2DLoadState,
  hoveredPolygon: Viewport2DPolygonSummary | null,
): string[] {
  switch (state.status) {
    case "error":
      return [state.message];
    case "loading":
      return ["Loading cross-section"];
    case "ready":
      if (hoveredPolygon) {
        return [
          `tet ${hoveredPolygon.parentElementId}`,
          `${state.metric} ${formatQuality(hoveredPolygon.qualityValue)}`,
          `(${formatCoordinate(hoveredPolygon.centroid.u)}, ${formatCoordinate(hoveredPolygon.centroid.v)})`,
        ];
      }
      return [
        `${state.query.plane.toUpperCase()} ${state.query.positionPercent}%`,
        state.metric,
        `${state.statistics.visiblePolygonCount} / ${state.statistics.polygonCount} polygons`,
        `min ${formatQuality(state.statistics.min)}`,
        `mean ${formatQuality(state.statistics.mean)}`,
      ];
    case "unavailable":
      return [state.message];
  }
}

function formatQuality(value: number | null): string {
  return value === null ? "n/a" : Number(value.toPrecision(4)).toString();
}

function formatCoordinate(value: number): string {
  return Number(value.toPrecision(5)).toString();
}
