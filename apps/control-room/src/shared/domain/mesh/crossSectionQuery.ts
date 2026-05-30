import type {
  CrossSectionQuery,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";

const DEFAULT_CROSS_SECTION_QUERY: CrossSectionQuery = {
  includePolygons: true,
  includeWireframe: true,
  plane: "xy",
  positionPercent: 50,
};

const CROSS_SECTION_PLANE_BY_AXIS = {
  x: "yz",
  y: "xz",
  z: "xy",
} as const;

export function resolveCrossSectionQueryFromVisualizationState(
  visualizationState: VisualizationStateResource | null | undefined,
): CrossSectionQuery {
  const clip = visualizationState?.clip;
  const slice = visualizationState?.slice;
  const source = clip?.enabled ? clip : slice;
  if (!source) return DEFAULT_CROSS_SECTION_QUERY;

  return {
    includePolygons: true,
    includeWireframe: visualizationState?.slice.show_mesh ?? true,
    plane: CROSS_SECTION_PLANE_BY_AXIS[source.axis],
    positionPercent: clampPercent(source.position_percent),
  };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CROSS_SECTION_QUERY.positionPercent;
  return Math.min(100, Math.max(0, value));
}
