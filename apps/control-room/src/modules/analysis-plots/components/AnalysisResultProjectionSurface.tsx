import { useMemo } from "react";

import type { KernelApi } from "@/kernel/types";
import type {
  ChartRenderModel,
  ChartRenderResultCoordinate,
  ChartRenderResultSelectionRef,
  ChartResultExportContext,
} from "@/shared/analysis-charts/chartRenderer";
import type {
  AnalysisResultProjectionDescriptor,
  AnalysisResultProjectionResource,
  AnalysisResultItemKind,
  AnalysisResultProductKind,
  AnalysisResultSelectionRef,
  AnalysisResultSpectrumOutputScope,
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

import { EChartsSurface, tableSeriesRenderModel } from "./EChartsSurface";

export interface AnalysisResultProjectionSurfaceProps {
  kernel: KernelApi;
  model: AnalysisResultProjectionChartModel;
  onProjectionSelect: (projectionId: string) => void;
  onSpectrumOutputScopeSelect?: (scope: AnalysisResultSpectrumOutputScope) => void;
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
  onSpectrumOutputScopeSelect,
  onPointSelect,
  projections,
  productKind,
  resource,
  selectedSelection,
  selectedProjectionId,
  status,
}: AnalysisResultProjectionSurfaceProps) {
  const selectedOrdinal =
    selectedSelection !== null &&
    selectedSelection.projectionId === resource?.projection_id &&
    selectedSelection?.projectionRevision === resource?.projection_revision
      ? selectedSelection.projectionOrdinal ?? null
      : null;
  const projectionStatus = resource?.unsupported_reason ? "unsupported" : status;
  const subtitle = resource
    ? `${resource.dataset_id} Â· revision ${resource.projection_revision}`
    : "Run-scoped result projection";
  const selectedLabel = useMemo(() => {
    if (!resource || selectedOrdinal == null) return null;
    const point = resource.selection_index.find(
      (entry) => entry.ordinal === selectedOrdinal,
    );
    if (!point) return null;
    return point.item_id ?? point.sample_id ?? `point ${point.ordinal}`;
  }, [resource, selectedOrdinal]);
  const exportSelectionRefs = useMemo(
    () => projectionSelectionRefs(model.exportSeries ?? model.series),
    [model.exportSeries, model.series],
  );
  const exportProvenance = useMemo(
    () =>
      resource
        ? {
            datasetId: resource.dataset_id,
            datasetRevision: resource.dataset_revision,
            fixedCoordinates: resource.fixed_coordinates.map(resultCoordinate),
            projectionId: resource.projection_id,
            projectionRevision: resource.projection_revision,
            runId: resource.run_id,
            selectionRefs: exportSelectionRefs,
            stageId: selectedSelection?.stageId ?? null,
          } satisfies ChartResultExportContext
        : undefined,
    [exportSelectionRefs, resource, selectedSelection?.stageId],
  );
  const xAxisLabel = resource?.axis_labels.x ?? resource?.axis_mapping.x ?? "x";
  const modelExportSeries = model.exportSeries ?? model.series;
  const dataExportModel = useMemo(() => {
    if (!resource) return undefined;
    const exportRenderModel = tableSeriesRenderModel(
      modelExportSeries,
      modelExportSeries,
      xAxisLabel,
      projectionStatus,
    );
    return {
      ...exportRenderModel,
      provenance: {
        ...(exportRenderModel.provenance ?? {}),
        ...(exportProvenance ?? {}),
        dataRevision: resource.projection_revision,
        decimation: "none",
        descriptorId: `analysis:result-projection:${resource.dataset_id}:${resource.projection_id}`,
        displayUnits: exportRenderModel.provenance?.displayUnits ?? {},
        query: JSON.stringify({
          projectionId: resource.projection_id,
          series: modelExportSeries.map((series) => series.id),
          spectrumScope: model.scopeView?.kind ?? "unknown",
          sampleId: model.scopeView?.sampleId ?? null,
        }),
        resourceKey: `analysis:results:${resource.run_id}:${resource.dataset_id}:${resource.projection_id}`,
      },
    } satisfies ChartRenderModel;
  }, [exportProvenance, model.scopeView, modelExportSeries, projectionStatus, resource, xAxisLabel]);
  const scopeCaption = spectrumScopeCaption(productKind, model);
  const hasProjectionPoints = model.series.some((series) => series.points.length > 0);
  const requestedSpectrumScopes = model.requestedSpectrumOutputScopes ?? null;
  const hasPerSampleScope = requestedSpectrumScopes?.includes("per_sample") ?? false;
  const hasGlobalScope = requestedSpectrumScopes?.includes("global") ?? false;
  const selectedSpectrumScope = model.scopeView?.kind;
  const showSpectrumScopeSelect =
    productKind === "modal_eigen" && hasPerSampleScope && hasGlobalScope;

  return (
    <ChartSection
      className="fm-analysis-plots__subchart--result-projection"
      footer={selectedLabel ? <span>Selected result point: {selectedLabel}</span> : undefined}
      status={{
        primary: projectionStatus,
        pointSummary: resource
          ? `${modelExportSeries.reduce((count, series) => count + series.points.length, 0)} projection rows`
          : undefined,
        revision: resource?.projection_revision ?? null,
        trust: "unknown",
      }}
      subtitle={subtitle}
      title={resultProjectionTitle(productKind, resource?.projection_id)}
      toolbar={
        projections.length > 0 || showSpectrumScopeSelect ? (
          <>
            {projections.length > 0 ? (
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
            ) : null}
            {showSpectrumScopeSelect ? (
              <Select
                onValueChange={(value) => {
                  if (isSpectrumOutputScope(value)) {
                    onSpectrumOutputScopeSelect?.(value);
                  }
                }}
                value={
                  selectedSpectrumScope === "per_sample" || selectedSpectrumScope === "global"
                    ? selectedSpectrumScope
                    : ""
                }
              >
                <SelectTrigger aria-label="Spectrum output scope">
                  <SelectValue placeholder="Select spectrum scope" />
                </SelectTrigger>
                <SelectContent>
                  {requestedSpectrumScopes?.includes("per_sample") ? (
                    <SelectItem value="per_sample">Per sample</SelectItem>
                  ) : null}
                  {requestedSpectrumScopes?.includes("global") ? (
                    <SelectItem value="global">Global</SelectItem>
                  ) : null}
                </SelectContent>
              </Select>
            ) : null}
          </>
        ) : undefined
      }
    >
      {scopeCaption ? (
        <div className="fm-analysis-plots__status" role="status">
          {scopeCaption}
        </div>
      ) : null}
      {resource?.unsupported_reason ? (
        <div className="fm-analysis-plots__empty" role="status">
          {resource.unsupported_reason}
        </div>
      ) : model.series.length === 0 || !hasProjectionPoints ? (
        <div className="fm-analysis-plots__empty" role="status">
          {resource ? projectionEmptyMessage(model) : "Loading result projectionâ€¦"}
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
            exportProvenance={exportProvenance}
            dataExportModel={dataExportModel}
            series={model.series}
            xAxisLabel={xAxisLabel}
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
            .join(" Â· ")}
        </div>
      ) : null}
    </ChartSection>
  );
}

function resultCoordinate(
  coordinate: AnalysisResultProjectionResource["fixed_coordinates"][number],
): ChartRenderResultCoordinate {
  const vector = coordinate.vector3_si;
  return {
    axisId: coordinate.axis_id,
    label: coordinate.label ?? null,
    scalarSI: coordinate.scalar_si ?? null,
    token: coordinate.token,
    vector3SI:
      vector && vector.length === 3
        ? [vector[0]!, vector[1]!, vector[2]!] as const
        : null,
  };
}

function projectionSelectionRefs(
  series: NonNullable<AnalysisResultProjectionChartModel["exportSeries"]>,
): readonly ChartRenderResultSelectionRef[] {
  const selections = new Map<number, ChartRenderResultSelectionRef>();
  for (const entry of series) {
    for (const point of entry.points) {
      if (selections.has(point.rowIndex)) continue;
      selections.set(point.rowIndex, {
        branchId: point.branchId ?? null,
        itemId: point.itemId ?? null,
        ordinal: point.rowIndex,
        sampleId: point.sampleId ?? null,
      });
    }
  }
  return [...selections.values()];
}

function spectrumScopeCaption(
  productKind: AnalysisResultProductKind | null,
  model: AnalysisResultProjectionChartModel,
): string | null {
  if (productKind !== "modal_eigen") return null;
  const requested = model.requestedSpectrumOutputScopes ?? null;
  const scopeView = model.scopeView ?? { kind: "unknown" as const, sampleId: null };
  const requestedLabel = requested === null
    ? "unknown (not recorded)"
    : requested.length === 0
      ? "none"
      : requested.join(", ");
  let viewCopy: string;
  switch (scopeView.kind) {
    case "none":
      viewCopy = "No spectrum output scope was requested.";
      break;
    case "global":
      viewCopy = "The global view keeps returned sample and mode rows separate, with no averaging.";
      break;
    case "per_sample":
      viewCopy = scopeView.sampleId
        ? `The projection is filtered to sample ${scopeView.sampleId}.`
        : "Select a sample to view its per_sample projection.";
      break;
    case "unknown":
      viewCopy = "Projection rows are shown without scope filtering.";
      break;
  }
  return `Requested spectrum output scopes: ${requestedLabel}. ${viewCopy}`;
}

function projectionEmptyMessage(model: AnalysisResultProjectionChartModel): string {
  const scopeView = model.scopeView ?? { kind: "unknown" as const, sampleId: null };
  if (scopeView.kind === "none") {
    return "No spectrum output scopes were requested.";
  }
  if (scopeView.kind === "per_sample" && !scopeView.sampleId) {
    return "Select a sample to view its per_sample projection.";
  }
  if (scopeView.kind === "per_sample" && scopeView.sampleId) {
    return `The selected sample ${scopeView.sampleId} has no plottable projection points.`;
  }
  return "The selected result has no plottable projection points.";
}

function isSpectrumOutputScope(value: string): value is AnalysisResultSpectrumOutputScope {
  return value === "per_sample" || value === "global";
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
