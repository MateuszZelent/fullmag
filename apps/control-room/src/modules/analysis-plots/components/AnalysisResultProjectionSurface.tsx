import { useMemo } from "react";

import type { KernelApi } from "@/kernel/types";
import type {
  AnalysisResultProjectionDescriptor,
  AnalysisResultProjectionResource,
  AnalysisResultItemKind,
  AnalysisResultProductKind,
  AnalysisResultSelectionRef,
} from "@/shared/domain/analysis/results";
import { ChartSection } from "@/shared/analysis-charts/ChartSection";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";

import type { AnalysisResultProjectionChartModel } from "@/shared/domain/analysis/results";

import { EChartsSurface } from "./EChartsSurface";

export interface AnalysisResultProjectionSurfaceProps {
  kernel: KernelApi;
  model: AnalysisResultProjectionChartModel;
  onProjectionSelect: (projectionId: string) => void;
  onPointSelect: (selection: AnalysisResultProjectionSelection) => void;
  projections: readonly AnalysisResultProjectionDescriptor[];
  productKind: AnalysisResultProductKind | null;
  resource: AnalysisResultProjectionResource | null;
  selectedSelection: AnalysisResultSelectionRef | null;
  selectedProjectionId: string | null;
  status: string;
}

export interface AnalysisResultProjectionSelection {
  branchId: string | null;
  itemId: string | null;
  itemKind?: AnalysisResultItemKind | null;
  ordinal: number;
  sampleId: string | null;
}

export function AnalysisResultProjectionSurface({
  kernel,
  model,
  onProjectionSelect,
  onPointSelect,
  projections,
  productKind,
  resource,
  selectedSelection,
  selectedProjectionId,
  status,
}: AnalysisResultProjectionSurfaceProps) {
  const selectedOrdinal =
    selectedSelection?.projectionId === resource?.projection_id &&
    selectedSelection?.projectionRevision === resource?.projection_revision
      ? selectedSelection.projectionOrdinal ?? null
      : null;
  const projectionStatus = resource?.unsupported_reason ? "unsupported" : status;
  const subtitle = resource
    ? `${resource.dataset_id} · revision ${resource.projection_revision}`
    : "Run-scoped result projection";
  const selectedLabel = useMemo(() => {
    if (!resource || selectedOrdinal == null) return null;
    const point = resource.selection_index.find(
      (entry) => entry.ordinal === selectedOrdinal,
    );
    if (!point) return null;
    return point.item_id ?? point.sample_id ?? `point ${point.ordinal}`;
  }, [resource, selectedOrdinal]);

  return (
    <ChartSection
      className="fm-analysis-plots__subchart--result-projection"
      footer={selectedLabel ? <span>Selected result point: {selectedLabel}</span> : undefined}
      status={{
        primary: projectionStatus,
        pointSummary: resource
          ? `${resource.selection_index.length} selectable points`
          : undefined,
        revision: resource?.projection_revision ?? null,
        trust: "unknown",
      }}
      subtitle={subtitle}
      title={resultProjectionTitle(productKind, resource?.projection_id)}
      toolbar={
        projections.length > 0 ? (
          <Select
            onValueChange={onProjectionSelect}
            value={selectedProjectionId ?? ""}
          >
            <SelectTrigger aria-label="Analysis result projection">
              <SelectValue placeholder="Select projection" />
            </SelectTrigger>
            <SelectContent>
              {projections.map((projection) => (
                <SelectItem
                  disabled={!projection.selectable}
                  key={projection.projection_id}
                  value={projection.projection_id}
                >
                  {projection.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : undefined
      }
    >
      {resource?.unsupported_reason ? (
        <div className="fm-analysis-plots__empty" role="status">
          {resource.unsupported_reason}
        </div>
      ) : model.series.length === 0 ? (
        <div className="fm-analysis-plots__empty" role="status">
          {resource ? "The selected result has no plottable projection points." : "Loading result projection…"}
        </div>
      ) : resource ? (
        <div
          className="fm-analysis-plots__chart-frame"
          data-result-projection={resource.projection_id}
        >
          <EChartsSurface
            allSeries={model.series}
            bus={kernel.bus}
            chartId={`analysis-result:${resource.dataset_id}:${resource.projection_id}`}
            dataStatus={projectionStatus}
            onPointSelect={(point) => {
              const entry = model.selectionBySeriesId[point.seriesId]?.find(
                (candidate) => candidate.ordinal === point.point.rowIndex,
              );
              if (!entry) return;
              onPointSelect({
                branchId: entry.branch_id ?? null,
                itemId: entry.item_id ?? null,
                itemKind: entry.item_kind ?? null,
                ordinal: entry.ordinal,
                sampleId: entry.sample_id ?? null,
              });
            }}
            series={model.series}
            xAxisLabel={resource.axis_labels.x ?? resource.axis_mapping.x ?? "x"}
          />
        </div>
      ) : null}
      {resource && resource.fixed_coordinates.length > 0 ? (
        <div
          aria-label="Fixed coordinates"
          className="fm-analysis-plots__status"
          role="status"
        >
          Fixed coordinates: {resource.fixed_coordinates
            .map((coordinate) => `${coordinate.axis_id}=${coordinate.label ?? coordinate.token}`)
            .join(" · ")}
        </div>
      ) : null}
    </ChartSection>
  );
}

function resultProjectionTitle(
  productKind: AnalysisResultProductKind | null,
  projectionId: string | undefined,
): string {
  if (productKind === "time_domain_spectrum") {
    switch (projectionId) {
      case "response-spectrum":
        return "Response spectrum";
      case "susceptibility":
        return "Susceptibility";
      case "spectral-features":
      default:
        return "Spectral features";
    }
  }
  if (productKind === "dynamic_structure_factor") {
    return projectionId === "dsf-map"
      ? "Dynamic structure factor"
      : projectionId ?? "Dynamic structure factor";
  }
  return projectionId ?? "Analysis result projection";
}
