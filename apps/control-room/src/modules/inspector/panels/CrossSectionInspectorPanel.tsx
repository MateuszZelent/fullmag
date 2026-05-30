"use client";

import { useMemo } from "react";

import type {
  CrossSectionQualityMetric,
  CrossSectionQualityQuery,
} from "@/kernel/api/apiTypes";
import {
  useCrossSectionQualityResource,
  useCrossSectionResource,
} from "@/kernel/resources/crossSectionResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import { activeCrossSectionPlot } from "@/kernel/workspace/crossSectionWorkspace";
import { useCrossSectionWorkspaceSelector } from "@/kernel/workspace/useCrossSectionWorkspace";
import { resolveCrossSectionQueryFromVisualizationState } from "@/shared/domain/mesh/crossSectionQuery";
import {
  buildCrossSectionIntersectionStatistics,
  buildCrossSectionQualityStatistics,
} from "@/shared/domain/mesh/crossSectionStatistics";

import type { InspectorPanelProps } from "../inspectorTypes";
import { InspectorSection } from "../primitives/InspectorSection";
import {
  formatCount,
  formatValue,
  MeshResourceEmpty,
  MeshResourceFields,
} from "./MeshResourceView";
import { CrossSectionDraftEditor } from "./CrossSectionDraftEditor";
import { CrossSectionQualityChart } from "./CrossSectionQualityChart";

const DEFAULT_METRIC: CrossSectionQualityMetric = "skewness";
const QUALITY_THRESHOLD = 0.1;

export function CrossSectionInspectorPanel({ selection }: InspectorPanelProps) {
  const visualizationState = useVisualizationStateResource();
  const workspace = useCrossSectionWorkspaceSelector((state) => state);
  const draftMode = selection.ref?.type === "cross-section-draft";
  const selectedPlotId =
    selection.ref?.type === "cross-section-plot" ? selection.ref.plotId : null;
  const selectedPlot =
    selectedPlotId !== null
      ? workspace.plots.find((plot) => plot.id === selectedPlotId) ?? null
      : activeCrossSectionPlot(workspace);
  const visualizationQuery = useMemo(
    () => resolveCrossSectionQueryFromVisualizationState(visualizationState.data),
    [visualizationState.data],
  );
  const query = selectedPlot?.query ?? visualizationQuery;
  const frameExtent = selectedPlot?.frameExtent ?? "universe";
  const rotationDegrees = selectedPlot?.rotationDegrees ?? 0;
  const metric =
    selectedPlot?.metric ??
    visualizationState.data?.slice.mesh_quality_metric ??
    DEFAULT_METRIC;
  const qualityQuery: CrossSectionQualityQuery = {
    metric,
    plane: query.plane,
    positionPercent: query.positionPercent,
  };
  const crossSection = useCrossSectionResource(query, {
    enabled: !draftMode,
  });
  const quality = useCrossSectionQualityResource(qualityQuery, {
    enabled:
      !draftMode && crossSection.status === "ready" && Boolean(crossSection.data),
  });

  if (draftMode) {
    return (
      <CrossSectionDraftEditor
        draft={workspace.draft}
      />
    );
  }

  if (crossSection.status === "error" || quality.status === "error") {
    return (
      <MeshResourceEmpty
        label={
          crossSection.error?.message ??
          quality.error?.message ??
          "Cross-section data unavailable."
        }
      />
    );
  }
  if (crossSection.status !== "ready") {
    return <MeshResourceEmpty label="Loading cross-section resources." />;
  }
  if (!crossSection.data) {
    return <MeshResourceEmpty label="No FEM mesh cross-section is available." />;
  }

  const statistics = buildCrossSectionQualityStatistics(
    polygonQualitySamples(crossSection.data.polygonCount, quality.data),
    { threshold: QUALITY_THRESHOLD },
  );
  const intersectionStatistics = buildCrossSectionIntersectionStatistics(
    crossSection.data.intersectionKinds,
  );
  const selectedElement = resolveSelectedCrossSectionElement(
    selection,
    crossSection.data.parentElementIds,
    quality.data?.perElementQuality ?? null,
  );

  return (
    <div className="fm-cross-section-inspector">
      <InspectorSection title="Cut Plane">
        <MeshResourceFields
          fields={[
            ...(selectedPlot
              ? [{ label: "Plot", value: selectedPlot.name }]
              : []),
            { label: "Plane", value: query.plane.toUpperCase() },
            { label: "Frame", value: formatFrameExtent(frameExtent) },
            {
              label: "Position",
              unit: "%",
              value: formatValue(query.positionPercent),
            },
            {
              label: "Rotation",
              unit: "deg",
              value: formatValue(rotationDegrees),
            },
            { label: "Quality metric", value: metric },
            { label: "Wireframe", value: query.includeWireframe ? "shown" : "hidden" },
          ]}
        />
      </InspectorSection>

      <InspectorSection title="Cross-Section Statistics">
        <MeshResourceFields
          fields={[
            {
              label: "Intersected parent tets",
              value: formatCount(statistics.polygonCount),
            },
            {
              label: "Visible polygons",
              value: formatCount(statistics.visiblePolygonCount),
            },
            {
              label: "Mesh nodes on plane",
              value: formatCount(intersectionStatistics.meshNodeCount),
            },
            {
              label: "Edge-plane intersections",
              value: formatCount(intersectionStatistics.edgeIntersectionCount),
            },
            {
              label: "Intersection points",
              value: formatCount(intersectionStatistics.totalPointCount),
            },
            { label: "Min quality", value: formatQuality(statistics.min) },
            { label: "P5 quality", value: formatQuality(statistics.p05) },
            { label: "Mean quality", value: formatQuality(statistics.mean) },
            { label: "Max quality", value: formatQuality(statistics.max) },
            {
              label: "Below threshold",
              value: formatCount(statistics.belowThresholdCount),
            },
          ]}
        />
        {statistics.histogram.length > 0 ? (
          <CrossSectionQualityChart
            bins={statistics.histogram}
            totalCount={statistics.polygonCount}
          />
        ) : null}
      </InspectorSection>

      <InspectorSection title="Selected Element">
        {selectedElement ? (
          <MeshResourceFields
            fields={[
              { label: "Parent tet", value: selectedElement.parentElementId },
              { label: "Polygon", value: selectedElement.polygonIndex },
              { label: "Quality", value: formatQuality(selectedElement.quality) },
            ]}
          />
        ) : (
          <MeshResourceEmpty label="Hover or click a cross-section polygon to inspect its parent tet." />
        )}
      </InspectorSection>
    </div>
  );
}

function polygonQualitySamples(
  polygonCount: number,
  quality: { perElementQuality: Float32Array } | null,
) {
  return Array.from({ length: polygonCount }, (_, index) => ({
    qualityValue: quality?.perElementQuality[index] ?? null,
    visible: true,
  }));
}

function resolveSelectedCrossSectionElement(
  selection: Selection,
  parentElementIds: Uint32Array,
  qualityValues: Float32Array | null,
): {
  parentElementId: number;
  polygonIndex: number;
  quality: number | null;
} | null {
  const selectedElementId =
    selection.ref?.type === "mesh-quality-element"
      ? selection.ref.elementIndex
      : null;
  if (selectedElementId === null) return null;

  for (let polygon = 0; polygon < parentElementIds.length; polygon++) {
    const parentElementId = parentElementIds[polygon];
    if (parentElementId !== selectedElementId) continue;
    return {
      parentElementId,
      polygonIndex: polygon,
      quality: qualityValues?.[polygon] ?? null,
    };
  }

  return {
    parentElementId: selectedElementId,
    polygonIndex: -1,
    quality: null,
  };
}

function formatQuality(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(3);
}

function formatFrameExtent(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
