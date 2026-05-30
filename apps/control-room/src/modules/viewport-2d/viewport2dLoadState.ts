import type {
  CrossSectionQualityMetric,
  CrossSectionQuery,
} from "@/kernel/api/apiTypes";
import type {
  DecodedCrossSection,
  DecodedCrossSectionQuality,
} from "@/kernel/api/codecs";
import type { ResourceStatus } from "@/kernel/resources/resourceTypes";
import {
  buildCrossSectionIntersectionStatistics,
  buildCrossSectionQualityStatistics,
  type CrossSectionIntersectionStatistics,
  type CrossSectionQualityStatistics,
} from "@/shared/domain/mesh/crossSectionStatistics";

import {
  DEFAULT_VIEWPORT_2D_RENDER_OPTIONS,
  buildViewport2DRenderModel,
  type Viewport2DRenderModel,
  type Viewport2DRenderOptions,
} from "./viewport2dRenderModel";

export const DEFAULT_VIEWPORT_2D_METRIC: CrossSectionQualityMetric = "skewness";
export const FALLBACK_VIEWPORT_2D_QUERY: Required<CrossSectionQuery> = {
  includePolygons: true,
  includeWireframe: true,
  plane: "xy",
  positionPercent: 50,
};

export { DEFAULT_VIEWPORT_2D_RENDER_OPTIONS };

export type Viewport2DLoadState =
  | { status: "error"; message: string }
  | { status: "loading" }
  | {
      intersectionStatistics: CrossSectionIntersectionStatistics;
      metric: CrossSectionQualityMetric;
      model: Viewport2DRenderModel;
      query: CrossSectionQuery;
      status: "ready";
      statistics: CrossSectionQualityStatistics;
    }
  | { status: "unavailable"; message: string };

interface Viewport2DResourceSnapshot<TData> {
  data: TData | null;
  error: Error | null;
  status: ResourceStatus;
}

interface Viewport2DLoadStateInput {
  crossSection: Viewport2DResourceSnapshot<DecodedCrossSection>;
  hasActivePlot: boolean;
  metric: CrossSectionQualityMetric;
  quality: Viewport2DResourceSnapshot<DecodedCrossSectionQuality>;
  query: CrossSectionQuery;
  renderOptions: Viewport2DRenderOptions;
}

export function buildViewport2DLoadState({
  crossSection,
  hasActivePlot,
  metric,
  quality,
  query,
  renderOptions,
}: Viewport2DLoadStateInput): Viewport2DLoadState {
  if (!hasActivePlot) {
    return {
      message: "Create a 2D plot from the cross-section draft.",
      status: "unavailable",
    };
  }
  if (crossSection.status === "error") {
    return {
      message: crossSection.error?.message ?? "Cross-section unavailable",
      status: "error",
    };
  }
  if (crossSection.status === "loading" || crossSection.status === "stale") {
    return { status: "loading" };
  }
  if (crossSection.status === "ready" && !crossSection.data) {
    return {
      message: "No FEM mesh cross-section",
      status: "unavailable",
    };
  }
  if (crossSection.status !== "ready" || !crossSection.data) {
    return { status: "loading" };
  }
  if (quality.status === "error") {
    return {
      message: quality.error?.message ?? "Cross-section quality unavailable",
      status: "error",
    };
  }
  if (quality.status === "loading" || quality.status === "stale") {
    return { status: "loading" };
  }

  const model = buildViewport2DRenderModel(
    crossSection.data,
    quality.data,
    renderOptions,
  );
  return {
    intersectionStatistics: buildCrossSectionIntersectionStatistics(
      crossSection.data.intersectionKinds,
    ),
    metric,
    model,
    query,
    statistics: buildCrossSectionQualityStatistics(model.polygons, {
      threshold: 0.1,
    }),
    status: "ready",
  };
}
