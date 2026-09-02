"use client";

import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { KeyboardEvent, ReactNode } from "react";

import type {
  AnalysisResultAxisResource,
  AnalysisResultAxisValueResource,
  AnalysisResultAxisValuesResource,
  AnalysisResultBranchPageResource,
  AnalysisResultDatasetManifestResource,
  AnalysisResultItemPageResource,
  AnalysisResultSamplePageResource,
} from "@/kernel/api/apiTypes";
import { useAnalysisResultAxisValuesResource } from "@/kernel/resources/analysisResultResources";
import {
  analysisResultSelectionRef,
  type AnalysisResultSelectionRef,
} from "@/shared/domain/analysis/results";
import { createAnalysisResultFieldOverlayIntent } from "@/kernel/visualization/AnalysisResultFieldOverlayIntent";
import { Button } from "@/shared/ui/Button";
import type { ResourceStatus } from "@/kernel/resources/resourceTypes";

import {
  formatResultFrequency,
  formatResultResidual,
  resultPageForDataset,
  type ResultDatasetBrowserModel,
  type ResultDatasetItemStatusFilter,
} from "./resultDatasetBrowserModel";
import { Input } from "@/shared/ui/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";

export interface ResultDatasetBrowserProps {
  manifest: AnalysisResultDatasetManifestResource | null;
  branchesPage: AnalysisResultBranchPageResource | null;
  branchesResourceStatus: ResourceStatus;
  catalogResourceStatus: ResourceStatus;
  catalogPage: {
    cursor?: string | null;
    next_cursor?: string | null;
    total_count?: number;
  } | null;
  model: ResultDatasetBrowserModel;
  itemsPage: AnalysisResultItemPageResource | null;
  itemsResourceStatus: ResourceStatus;
  manifestResourceStatus: ResourceStatus;
  selectedDatasetId: string | null;
  samplesPage: AnalysisResultSamplePageResource | null;
  samplesResourceStatus: ResourceStatus;
  axisFilters: Readonly<Record<string, string>>;
  branchFilter: string | null;
  datasetSearch: string;
  itemFieldFilter: "all" | "true" | "false";
  itemFrequencyMax: string;
  itemFrequencyMin: string;
  itemResidualMax: string;
  itemFilterError: string | null;
  itemStatusFilter: ResultDatasetItemStatusFilter;
  itemSort: string;
  serverFiltering: boolean;
  serverSorting: boolean;
  onSelect: (selection: AnalysisResultSelectionRef) => void;
  onDatasetSearchChange: (value: string) => void;
  onCatalogPageChange: (cursor: string | null) => void;
  onAxisFilterChange: (axisId: string, token: string | null) => void;
  onBranchFilterChange: (branchId: string | null) => void;
  onBranchPageChange: (cursor: string | null) => void;
  onFollowBranch: (branchId: string | null) => void;
  onInspectProvenance: () => void;
  onItemFieldFilterChange: (value: "all" | "true" | "false") => void;
  onItemFrequencyMaxChange: (value: string) => void;
  onItemFrequencyMinChange: (value: string) => void;
  onItemPageChange: (cursor: string | null) => void;
  onItemResidualMaxChange: (value: string) => void;
  onItemStatusFilterChange: (value: ResultDatasetItemStatusFilter) => void;
  onItemSortChange: (value: string) => void;
  onOpenAnalysis: () => void;
  onPlotField: (selection: AnalysisResultSelectionRef) => void;
  onSamplePageChange: (cursor: string | null) => void;
  followedBranchId: string | null;
  selectedSelection: AnalysisResultSelectionRef | null;
}

function datasetSelection(
  dataset: ResultDatasetBrowserModel["datasets"][number],
): AnalysisResultSelectionRef {
  return analysisResultSelectionRef({
    datasetId: dataset.datasetId,
    datasetRevision: dataset.datasetRevision,
    focus: "dataset",
    runId: dataset.runId,
    stageId: dataset.stageId,
  });
}

function resultPageStatusMessage(
  status: ResourceStatus,
  hasData: boolean,
): string | null {
  if (status === "loading") {
    return hasData ? "Refreshing result page…" : "Loading result page…";
  }
  if (status === "error") {
    return hasData
      ? "Result page refresh failed; showing the last available page."
      : "Result page unavailable.";
  }
  if (status === "stale") {
    return hasData ? "Refreshing result page…" : "Loading result page…";
  }
  return null;
}

function focusAdjacentResultRow(event: KeyboardEvent<HTMLButtonElement>): void {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const list = event.currentTarget.closest<HTMLElement>("ul, [role='list']");
  if (!list) return;
  const rows = Array.from(
    list.querySelectorAll<HTMLButtonElement>("button[data-result-row='true']"),
  );
  const currentIndex = rows.indexOf(event.currentTarget);
  if (currentIndex < 0 || rows.length < 2) return;
  const nextIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? rows.length - 1
        : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + rows.length) %
          rows.length;
  const nextRow = rows[nextIndex];
  if (!nextRow || nextRow === event.currentTarget) return;
  event.preventDefault();
  nextRow.focus();
}

export function resultDatasetItemSelection(
  manifest: AnalysisResultDatasetManifestResource,
  item: ResultDatasetBrowserModel["items"][number],
): AnalysisResultSelectionRef {
  return analysisResultSelectionRef({
    branchId: item.branchId ?? undefined,
    datasetId: manifest.dataset_id,
    datasetRevision: manifest.dataset_revision,
    displayIndex: item.displayIndex ?? undefined,
    fieldId: item.fieldId ?? undefined,
    fieldRef: item.fieldRef ?? undefined,
    focus: "item",
    itemId: item.itemId,
    itemKind: item.itemKindCode,
    runId: manifest.run_id,
    sampleId: item.sampleId,
    sampleIndex: item.sampleIndex ?? undefined,
    stageId: manifest.stage_id,
    fieldRevision: item.fieldRef?.field_revision ?? undefined,
  });
}

export function ResultDatasetBrowser({
  manifest,
  branchesPage,
  branchesResourceStatus,
  catalogPage,
  catalogResourceStatus,
  model,
  itemsPage,
  itemsResourceStatus,
  manifestResourceStatus,
  onSelect,
  onItemPageChange,
  onSamplePageChange,
  datasetSearch,
  itemFieldFilter,
  itemSort,
  onCatalogPageChange,
  onDatasetSearchChange,
  onItemFieldFilterChange,
  onItemSortChange,
  onAxisFilterChange,
  onBranchFilterChange,
  onBranchPageChange,
  onFollowBranch,
  branchFilter,
  axisFilters,
  samplesPage,
  samplesResourceStatus,
  selectedDatasetId,
  onInspectProvenance,
  onOpenAnalysis,
  onPlotField,
  itemFrequencyMax,
  itemFrequencyMin,
  itemFilterError,
  itemResidualMax,
  itemStatusFilter,
  onItemFrequencyMaxChange,
  onItemFrequencyMinChange,
  onItemResidualMaxChange,
  onItemStatusFilterChange,
  selectedSelection,
  followedBranchId,
  serverFiltering,
  serverSorting,
}: ResultDatasetBrowserProps) {
  const selectedDatasetSelection =
    manifest &&
    selectedSelection?.runId === manifest.run_id &&
    selectedSelection.stageId === manifest.stage_id &&
    selectedSelection.datasetId === manifest.dataset_id &&
    selectedSelection.datasetRevision === manifest.dataset_revision
      ? selectedSelection
      : null;
  const selectedFieldIntent = createAnalysisResultFieldOverlayIntent(
    manifest?.capabilities.fields ? selectedDatasetSelection : null,
  );
  const fixedCoordinateSummary = Object.entries(axisFilters)
    .map(([axisId, token]) => {
      const axis = model.axes.find((candidate) => candidate.axisId === axisId);
      return `${axis?.label ?? axisId} = ${token}`;
    })
    .join(" · ");
  return (
    <section
      aria-label="Result datasets"
      className="fm-results-dataset-browser"
    >
      <div className="fm-results-dataset-browser__layout">
        <nav
          aria-label="Result datasets"
          className="fm-results-dataset-browser__datasets"
        >
          <div className="fm-results-dataset-browser__section-heading">
            <span>Datasets</span>
            <span>{catalogPage?.total_count ?? model.datasets.length}</span>
          </div>
          <label
            className="fm-results-dataset-browser__filter-label"
            htmlFor="fm-results-dataset-search"
          >
            Search datasets
          </label>
          <Input
            id="fm-results-dataset-search"
            onChange={(event) => onDatasetSearchChange(event.target.value)}
            placeholder="ID or title"
            value={datasetSearch}
          />
          {model.datasets.length === 0 ? (
            <p className="fm-results-dataset-browser__empty">
              {catalogResourceStatus === "loading" || catalogResourceStatus === "stale"
                ? "Loading result datasets…"
                : catalogResourceStatus === "error"
                  ? "Result datasets unavailable."
                  : datasetSearch.trim()
                    ? "No matching result datasets."
                    : "No published result datasets."}
            </p>
          ) : (
            <ul className="fm-results-dataset-browser__dataset-list">
              {model.datasets.map((dataset) => (
                <li key={dataset.datasetId}>
                  <button
                    aria-current={
                      dataset.datasetId === selectedDatasetId ? "page" : undefined
                    }
                    className="fm-results-dataset-browser__dataset"
                    data-result-row="true"
                    data-status={dataset.status}
                    onClick={() => onSelect(datasetSelection(dataset))}
                    onKeyDown={focusAdjacentResultRow}
                    type="button"
                  >
                    <span className="fm-results-dataset-browser__dataset-title">
                      {dataset.label}
                    </span>
                    <span className="fm-results-dataset-browser__dataset-meta">
                      {dataset.productKind} · {dataset.sampleCount} samples ·{" "}
                      {dataset.itemCount} items
                    </span>
                    <span className="fm-results-dataset-browser__status">
                      {dataset.statusLabel}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <ResultPageControls
            ariaLabel="Dataset page"
            onChange={onCatalogPageChange}
            page={catalogPage}
          />
        </nav>

        <div className="fm-results-dataset-browser__detail">
          {!manifest ? (
            <p className="fm-results-dataset-browser__empty">
              {manifestResourceStatus === "loading"
                ? "Loading dataset manifest…"
                : manifestResourceStatus === "error"
                  ? "Dataset manifest unavailable."
                  : "Select a dataset to inspect its axes and result items."}
            </p>
          ) : (
            <>
              <header className="fm-results-dataset-browser__header">
                <div>
                  <p className="fm-results-dataset-browser__eyebrow">
                    {manifest.product_kind}
                  </p>
                  <h3>{manifest.title}</h3>
                </div>
                <div className="fm-results-dataset-browser__header-actions">
                  <span data-status={model.manifestStatus}>
                    {manifest.status.completeness}
                  </span>
                  <div
                    aria-label="Result actions"
                    className="fm-results-dataset-browser__actions"
                  >
                    <Button
                      size="sm"
                      type="button"
                      onClick={onOpenAnalysis}
                    >
                      Open in Analysis
                    </Button>
                    <Button
                      disabled={!selectedFieldIntent}
                      size="sm"
                      title={
                        selectedFieldIntent
                          ? "Plot the selected verified result field in the unified 3D viewport."
                          : "Select an item with a verified complex XYZ field and immutable mesh reference."
                      }
                      type="button"
                      onClick={() => {
                        if (selectedFieldIntent && selectedDatasetSelection) {
                          onPlotField(selectedDatasetSelection);
                        }
                      }}
                    >
                      Plot field
                    </Button>
                    <Button
                      size="sm"
                      type="button"
                      onClick={onInspectProvenance}
                    >
                      Inspect provenance
                    </Button>
                  </div>
                </div>
              </header>

              <div className="fm-results-dataset-browser__axes" aria-label="Dataset axes">
                {model.axes.map((axis) => (
                  <ResultDatasetAxisControl
                    axis={axis}
                    axisResource={
                      manifest.axes.find(
                        (candidate) => candidate.axis_id === axis.axisId,
                      ) ?? null
                    }
                    axisFilters={axisFilters}
                    datasetId={manifest.dataset_id}
                    datasetRevision={manifest.dataset_revision}
                    disabled={!serverFiltering}
                    key={`${manifest.dataset_id}:${manifest.dataset_revision}:${axis.axisId}`}
                    onAxisFilterChange={onAxisFilterChange}
                    runId={manifest.run_id}
                  />
                ))}
              </div>
              {fixedCoordinateSummary ? (
                <p
                  aria-label="Fixed coordinates"
                  className="fm-results-dataset-browser__status"
                  role="status"
                >
                  Fixed coordinates: {fixedCoordinateSummary}
                </p>
              ) : null}

              <div className="fm-results-dataset-browser__filters" aria-label="Result filters">
                {!serverFiltering || !serverSorting ? (
                  <p className="fm-results-dataset-browser__status" role="status">
                    {serverFiltering && !serverSorting
                      ? "Server sorting is unavailable for this dataset."
                      : !serverFiltering && serverSorting
                        ? "Server filtering is unavailable for this dataset."
                        : "Server filtering and sorting are unavailable for this dataset."}
                  </p>
                ) : null}
                {itemFilterError ? (
                  <p className="fm-results-dataset-browser__status" role="alert">
                    {itemFilterError}
                  </p>
                ) : null}
                <label className="fm-results-dataset-browser__filter-label">
                  Item order
                  <Select
                    disabled={!serverSorting}
                    onValueChange={onItemSortChange}
                    value={itemSort}
                  >
                    <SelectTrigger aria-label="Item order">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="display_index_asc">Display order</SelectItem>
                      <SelectItem value="frequency_asc">Frequency ascending</SelectItem>
                      <SelectItem value="frequency_desc">Frequency descending</SelectItem>
                      <SelectItem value="item_id_asc">Item ID</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                <label className="fm-results-dataset-browser__filter-label">
                  Field availability
                  <Select
                    disabled={!serverFiltering}
                    onValueChange={(value) =>
                      onItemFieldFilterChange(value as "all" | "true" | "false")
                    }
                    value={itemFieldFilter}
                  >
                    <SelectTrigger aria-label="Field availability">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All items</SelectItem>
                      <SelectItem value="true">Field ready</SelectItem>
                      <SelectItem value="false">Spectrum only</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                <label className="fm-results-dataset-browser__filter-label">
                  Item status
                  <Select
                    disabled={!serverFiltering}
                    onValueChange={(value) =>
                      onItemStatusFilterChange(value as ResultDatasetItemStatusFilter)
                    }
                    value={itemStatusFilter}
                  >
                    <SelectTrigger aria-label="Item status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All statuses</SelectItem>
                      <SelectItem value="ready">Ready</SelectItem>
                      <SelectItem value="partial">Partial</SelectItem>
                      <SelectItem value="interrupted">Interrupted</SelectItem>
                      <SelectItem value="corrupt">Corrupt</SelectItem>
                      <SelectItem value="legacy">Legacy</SelectItem>
                      <SelectItem value="unsupported">Unsupported</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                {manifest.capabilities.branch_tracking ? (
                  <label className="fm-results-dataset-browser__filter-label">
                    Branch filter
                    <Select
                      disabled={!serverFiltering}
                      onValueChange={(value) =>
                        onBranchFilterChange(value === "__all__" ? null : value)
                      }
                      value={branchFilter ?? "__all__"}
                    >
                      <SelectTrigger aria-label="Branch filter">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__all__">All branches</SelectItem>
                        {branchFilter &&
                        !model.branches.some((branch) => branch.branchId === branchFilter) ? (
                          <SelectItem value={branchFilter}>
                            {branchFilter} (selected)
                          </SelectItem>
                        ) : null}
                        {model.branches.map((branch) => (
                          <SelectItem key={branch.branchId} value={branch.branchId}>
                            {branch.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                ) : null}
                <label className="fm-results-dataset-browser__filter-label">
                  Frequency min [Hz]
                  <Input
                    aria-label="Frequency minimum [Hz]"
                    disabled={!serverFiltering}
                    inputMode="decimal"
                    onChange={(event) => onItemFrequencyMinChange(event.target.value)}
                    placeholder="No minimum"
                    type="number"
                    value={itemFrequencyMin}
                  />
                </label>
                <label className="fm-results-dataset-browser__filter-label">
                  Frequency max [Hz]
                  <Input
                    aria-label="Frequency maximum [Hz]"
                    disabled={!serverFiltering}
                    inputMode="decimal"
                    onChange={(event) => onItemFrequencyMaxChange(event.target.value)}
                    placeholder="No maximum"
                    type="number"
                    value={itemFrequencyMax}
                  />
                </label>
                <label className="fm-results-dataset-browser__filter-label">
                  Residual max [relative L2]
                  <Input
                    aria-label="Residual maximum [relative L2]"
                    disabled={!serverFiltering}
                    inputMode="decimal"
                    min="0"
                    onChange={(event) => onItemResidualMaxChange(event.target.value)}
                    placeholder="No maximum"
                    type="number"
                    value={itemResidualMax}
                  />
                </label>
              </div>

              {manifest.capabilities.branch_tracking ? (
                <section
                  aria-label="Result branches"
                  className="fm-results-dataset-browser__branches"
                >
                  <div className="fm-results-dataset-browser__section-heading">
                    <span>Tracked branches</span>
                    <span>{branchesPage?.total_count ?? model.branches.length}</span>
                  </div>
                  {resultPageStatusMessage(branchesResourceStatus, Boolean(branchesPage)) ? (
                    <p className="fm-results-dataset-browser__status" role="status">
                      {resultPageStatusMessage(branchesResourceStatus, Boolean(branchesPage))}
                    </p>
                  ) : null}
                  {branchesPage?.unsupported_reason ? (
                    <p className="fm-results-dataset-browser__empty">
                      {branchesPage.unsupported_reason}
                    </p>
                  ) : model.branches.length === 0 ? (
                    resultPageStatusMessage(branchesResourceStatus, Boolean(branchesPage)) ? null : (
                      <p className="fm-results-dataset-browser__empty">
                        No tracked branch page loaded.
                      </p>
                    )
                  ) : (
                    <VirtualizedResultRows
                      ariaLabel="Result branch page"
                      items={model.branches}
                      itemKey={(branch) => branch.branchId}
                    >
                      {(branch) => (
                        <div className="fm-results-dataset-browser__branch-row">
                          <button
                            aria-current={
                              selectedDatasetSelection?.branchId === branch.branchId
                                ? "true"
                                : undefined
                            }
                            className="fm-results-dataset-browser__row"
                            data-result-row="true"
                            data-status={branch.status}
                            onClick={() =>
                              onSelect(
                                analysisResultSelectionRef({
                                  branchId: branch.branchId,
                                  datasetId: manifest.dataset_id,
                                  datasetRevision: manifest.dataset_revision,
                                  focus: "branch",
                                  runId: manifest.run_id,
                                  stageId: manifest.stage_id,
                                }),
                              )
                            }
                            type="button"
                          >
                            <span>{branch.label}</span>
                            <small>{branch.branchId}</small>
                            <small>{branch.pointCount} points · {branch.statusLabel}</small>
                          </button>
                          <Button
                            aria-pressed={followedBranchId === branch.branchId}
                            className="fm-results-dataset-browser__follow-branch"
                            disabled={!serverFiltering}
                            onClick={() =>
                              onFollowBranch(
                                followedBranchId === branch.branchId
                                  ? null
                                  : branch.branchId,
                              )
                            }
                            size="sm"
                            type="button"
                          >
                            {followedBranchId === branch.branchId
                              ? "Stop following"
                              : "Follow branch"}
                          </Button>
                        </div>
                      )}
                    </VirtualizedResultRows>
                  )}
                  <ResultPageControls
                    ariaLabel="Branch page"
                    page={branchesPage}
                    onChange={onBranchPageChange}
                  />
                </section>
              ) : null}

              <div className="fm-results-dataset-browser__columns">
                <section aria-label="Result samples">
                  <div className="fm-results-dataset-browser__section-heading">
                    <span>Samples / slices</span>
                    <span>{samplesPage?.total_count ?? model.samples.length}</span>
                  </div>
                  {resultPageStatusMessage(samplesResourceStatus, Boolean(samplesPage)) ? (
                    <p className="fm-results-dataset-browser__status" role="status">
                      {resultPageStatusMessage(samplesResourceStatus, Boolean(samplesPage))}
                    </p>
                  ) : null}
                  {model.samples.length === 0 ? (
                    <p className="fm-results-dataset-browser__empty">
                      {samplesResourceStatus === "loading"
                        ? "Loading sample page…"
                        : samplesResourceStatus === "error"
                          ? "Sample page unavailable."
                          : "No sample page loaded."}
                    </p>
                  ) : (
                    <VirtualizedResultRows
                      ariaLabel="Result sample page"
                      items={model.samples}
                      itemKey={(sample) => sample.sampleId}
                    >
                      {(sample) => (
                        <button
                          aria-current={
                            selectedDatasetSelection?.sampleId === sample.sampleId
                              ? "true"
                              : undefined
                          }
                          className="fm-results-dataset-browser__row"
                          data-result-row="true"
                          data-status={sample.status}
                          onClick={() =>
                            onSelect(
                              analysisResultSelectionRef({
                                datasetId: manifest.dataset_id,
                                datasetRevision: manifest.dataset_revision,
                                focus: "sample",
                                runId: manifest.run_id,
                                sampleId: sample.sampleId,
                                stageId: manifest.stage_id,
                              }),
                            )
                          }
                          type="button"
                        >
                          <span>{sample.label}</span>
                          <small>{sample.sampleId}</small>
                          <small>{sample.coordinates.join(" · ") || "no coordinates"}</small>
                          <small>{sample.itemCount} items · {sample.statusLabel}</small>
                        </button>
                      )}
                    </VirtualizedResultRows>
                  )}
                  <ResultPageControls
                    ariaLabel="Sample page"
                    page={samplesPage}
                    onChange={onSamplePageChange}
                  />
                </section>

                <section aria-label="Result items">
                  <div className="fm-results-dataset-browser__section-heading">
                    <span>Items</span>
                    <span>{itemsPage?.total_count ?? model.items.length}</span>
                  </div>
                  {resultPageStatusMessage(itemsResourceStatus, Boolean(itemsPage)) ? (
                    <p className="fm-results-dataset-browser__status" role="status">
                      {resultPageStatusMessage(itemsResourceStatus, Boolean(itemsPage))}
                    </p>
                  ) : null}
                  {model.items.length === 0 ? (
                    <p className="fm-results-dataset-browser__empty">
                      {itemsResourceStatus === "loading"
                        ? "Loading item page…"
                        : itemsResourceStatus === "error"
                          ? "Item page unavailable."
                          : "No item page loaded."}
                    </p>
                  ) : (
                    <VirtualizedResultRows
                      ariaLabel="Result item page"
                      items={model.items}
                      itemKey={(item) => item.itemId}
                    >
                      {(item) => (
                        <button
                          aria-current={
                            selectedDatasetSelection?.itemId === item.itemId
                              ? "true"
                              : undefined
                          }
                          className="fm-results-dataset-browser__row"
                          data-result-row="true"
                          data-status={item.status}
                          disabled={!item.selectable}
                          onClick={() =>
                            onSelect(resultDatasetItemSelection(manifest, item))
                          }
                          type="button"
                        >
                          <span>{item.label}</span>
                          <small>{item.itemId}</small>
                          <small>{item.itemKind} · {formatResultFrequency(item.frequencyHz)}</small>
                          <small>
                            {item.branchId ? `branch ${item.branchId} · ` : ""}
                            residual {formatResultResidual(item.residualRelativeL2)} · {" "}
                            {item.fieldAvailable ? "field ready" : "spectrum only"} · {item.statusLabel}
                          </small>
                        </button>
                      )}
                    </VirtualizedResultRows>
                  )}
                  <ResultPageControls
                    ariaLabel="Item page"
                    page={itemsPage}
                    onChange={onItemPageChange}
                  />
                </section>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

const FILTERABLE_RESULT_AXIS_ROLES = new Set([
  "outer_sweep",
  "parameter",
  "material",
  "geometry",
  "field",
]);

function ResultDatasetAxisControl({
  axis,
  axisFilters,
  axisResource,
  datasetId,
  datasetRevision,
  disabled,
  onAxisFilterChange,
  runId,
}: {
  axis: ResultDatasetBrowserModel["axes"][number];
  axisFilters: Readonly<Record<string, string>>;
  axisResource: AnalysisResultAxisResource | null;
  datasetId: string;
  datasetRevision: string;
  disabled: boolean;
  onAxisFilterChange: (axisId: string, token: string | null) => void;
  runId: string;
}) {
  const filterable = Boolean(
    axisResource && FILTERABLE_RESULT_AXIS_ROLES.has(axisResource.role),
  );
  const inlineValues = axisResource?.inline_values;
  if (!filterable || inlineValues != null) {
    return (
      <ResultDatasetAxisCard
        axis={axis}
        axisFilters={axisFilters}
        disabled={disabled}
        onAxisFilterChange={onAxisFilterChange}
        values={inlineValues ?? null}
      />
    );
  }
  return (
    <PagedResultDatasetAxisControl
      axis={axis}
      axisFilters={axisFilters}
      datasetId={datasetId}
      datasetRevision={datasetRevision}
      disabled={disabled}
      onAxisFilterChange={onAxisFilterChange}
      runId={runId}
    />
  );
}

function PagedResultDatasetAxisControl({
  axis,
  axisFilters,
  datasetId,
  datasetRevision,
  disabled,
  onAxisFilterChange,
  runId,
}: {
  axis: ResultDatasetBrowserModel["axes"][number];
  axisFilters: Readonly<Record<string, string>>;
  datasetId: string;
  datasetRevision: string;
  disabled: boolean;
  onAxisFilterChange: (axisId: string, token: string | null) => void;
  runId: string;
}) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const resource = useAnalysisResultAxisValuesResource(
    runId,
    datasetId,
    axis.axisId,
    {
      query: {
        limit: 256,
        ...(cursor ? { cursor } : {}),
        ...(search.trim() ? { search: search.trim() } : {}),
      },
    },
  );
  const identityCheckedPage = resultPageForDataset(resource.data, {
    dataset_id: datasetId,
    dataset_revision: datasetRevision,
    run_id: runId,
  });
  const page =
    identityCheckedPage?.axis_id === axis.axisId ? identityCheckedPage : null;
  const values = page?.values ?? [];
  const message =
    resource.data && !page
      ? "Axis values identity does not match the dataset manifest."
      : resource.status === "loading"
      ? "Loading axis values…"
      : resource.status === "error"
        ? "Axis values unavailable."
        : resource.status === "stale"
          ? "Refreshing axis values…"
            : values.length > 0
            ? null
            : "No axis values published.";
  const onSearchChange = (value: string) => {
    setSearch(value);
    setCursor(null);
  };
  return (
    <ResultDatasetAxisCard
      axis={axis}
      axisFilters={axisFilters}
      disabled={disabled}
      message={message}
      onAxisFilterChange={onAxisFilterChange}
      onPageChange={setCursor}
      page={page}
      onSearchChange={onSearchChange}
      search={search}
      searchable
      values={values}
    />
  );
}

function ResultDatasetAxisCard({
  axis,
  axisFilters,
  disabled = false,
  message,
  onAxisFilterChange,
  onPageChange,
  onSearchChange,
  page,
  search,
  searchable = false,
  values,
}: {
  axis: ResultDatasetBrowserModel["axes"][number];
  axisFilters: Readonly<Record<string, string>>;
  disabled?: boolean;
  message?: string | null;
  onAxisFilterChange: (axisId: string, token: string | null) => void;
  onPageChange?: (cursor: string | null) => void;
  onSearchChange?: (value: string) => void;
  page?: Pick<AnalysisResultAxisValuesResource, "cursor" | "next_cursor"> | null;
  search?: string;
  searchable?: boolean;
  values: readonly AnalysisResultAxisValueResource[] | null;
}) {
  const selectedToken = axisFilters[axis.axisId] ?? "__all__";
  const hasSelectedToken = values?.some((value) => value.token === selectedToken);
  const selectedIndex = values?.findIndex((value) => value.token === selectedToken) ?? -1;
  const stepValue = (delta: -1 | 1) => {
    if (!values || values.length < 2) return;
    const startIndex = selectedIndex >= 0 ? selectedIndex : delta > 0 ? -1 : 0;
    const nextIndex = (startIndex + delta + values.length) % values.length;
    const nextValue = values[nextIndex];
    if (nextValue) onAxisFilterChange(axis.axisId, nextValue.token);
  };
  return (
    <div className="fm-results-dataset-browser__axis">
      <div className="fm-results-dataset-browser__axis-heading">
        <span>
          {axis.label}: {axis.cardinality}
          {axis.unit ? ` ${axis.unit}` : ""}
        </span>
        <small>Role: {axis.role}</small>
        {searchable && onSearchChange ? (
          <Input
            aria-label={`${axis.label} search`}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search values"
            value={search ?? ""}
          />
        ) : null}
        {values && values.length > 0 ? (
          <Select
            disabled={disabled}
            onValueChange={(value) =>
              onAxisFilterChange(axis.axisId, value === "__all__" ? null : value)
            }
            value={selectedToken}
          >
            <SelectTrigger aria-label={`${axis.label} value`}>
              <SelectValue placeholder="All values" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All values</SelectItem>
              {selectedToken !== "__all__" && !hasSelectedToken ? (
                <SelectItem value={selectedToken}>{selectedToken} (selected)</SelectItem>
              ) : null}
              {values.map((value) => (
                <SelectItem
                  disabled={value.status === "unsupported" || value.status === "unavailable"}
                  key={value.token}
                  value={value.token}
                >
                  {value.label ?? value.token}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <small>{message ?? "Values are paged by the server"}</small>
        )}
        {values && values.length > 1 ? (
          <div className="fm-results-dataset-browser__axis-stepper">
            <Button
              aria-label={`${axis.label} previous value`}
              disabled={disabled}
              onClick={() => stepValue(-1)}
              size="sm"
              type="button"
            >
              Previous
            </Button>
            <Button
              aria-label={`${axis.label} next value`}
              disabled={disabled}
              onClick={() => stepValue(1)}
              size="sm"
              type="button"
            >
              Next
            </Button>
          </div>
        ) : null}
      </div>
      {page && onPageChange ? (
        <ResultPageControls
          ariaLabel={`${axis.label} values page`}
          onChange={onPageChange}
          page={page}
        />
      ) : null}
    </div>
  );
}

function VirtualizedResultRows<T>({
  ariaLabel,
  children,
  itemKey,
  items,
}: {
  ariaLabel: string;
  children: (item: T) => ReactNode;
  itemKey: (item: T) => string;
  items: readonly T[];
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [pendingFocusIndex, setPendingFocusIndex] = useState<number | null>(null);
  // TanStack Virtual exposes an imperative measurement API by design.
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: items.length,
    estimateSize: () => 72,
    getScrollElement: () => parentRef.current,
    overscan: 6,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();

  useEffect(() => {
    if (pendingFocusIndex == null) return;
    const button = parentRef.current?.querySelector<HTMLButtonElement>(
      `[data-result-row-index="${pendingFocusIndex}"]`,
    );
    if (!button) return;
    button.focus();
    setPendingFocusIndex(null);
  }, [pendingFocusIndex, virtualItems]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || target.dataset.resultRow !== "true") {
      return;
    }
    const row = target.closest<HTMLElement>("[data-result-row-index]");
    const currentIndex = Number(row?.dataset.resultRowIndex);
    if (!Number.isSafeInteger(currentIndex)) return;
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? currentIndex + 1
            : event.key === "ArrowUp"
              ? currentIndex - 1
              : null;
    if (
      nextIndex == null ||
      nextIndex < 0 ||
      nextIndex >= items.length ||
      nextIndex === currentIndex
    ) {
      return;
    }
    event.preventDefault();
    setPendingFocusIndex(nextIndex);
    rowVirtualizer.scrollToIndex(nextIndex, { align: "auto" });
  };

  return (
    <div
      aria-label={ariaLabel}
      className="fm-results-dataset-browser__virtual-list"
      onKeyDown={onKeyDown}
      ref={parentRef}
      role="list"
    >
      <div
        className="fm-results-dataset-browser__virtual-list-inner"
        style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
      >
        {virtualItems.map((virtualRow) => {
          const item = items[virtualRow.index];
          if (!item) return null;
          return (
            <div
              className="fm-results-dataset-browser__virtual-row"
              data-index={virtualRow.index}
              data-result-row-index={virtualRow.index}
              key={itemKey(item)}
              ref={rowVirtualizer.measureElement}
              role="listitem"
              style={{
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {children(item)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ResultPageControls({
  ariaLabel,
  onChange,
  page,
}: {
  ariaLabel: string;
  onChange: (cursor: string | null) => void;
  page: { cursor?: string | null; next_cursor?: string | null } | null;
}) {
  if (!page?.cursor && !page?.next_cursor) return null;
  return (
    <div
      aria-label={ariaLabel}
      className="fm-results-dataset-browser__page-controls"
    >
      <button
        disabled={!page.cursor}
        onClick={() => onChange(null)}
        type="button"
      >
        First page
      </button>
      <button
        disabled={!page.next_cursor}
        onClick={() => {
          if (page.next_cursor) onChange(page.next_cursor);
        }}
        type="button"
      >
        Next page
      </button>
    </div>
  );
}
