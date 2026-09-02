"use client";

import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ReactNode } from "react";

import type {
  AnalysisResultAxisValuesResource,
  AnalysisResultBranchPageResource,
  AnalysisResultDatasetManifestResource,
  AnalysisResultItemPageResource,
  AnalysisResultSamplePageResource,
} from "@/kernel/api/apiTypes";
import {
  analysisResultSelectionRef,
  type AnalysisResultSelectionRef,
} from "@/shared/domain/analysis/results";

import {
  formatResultFrequency,
  type ResultDatasetBrowserModel,
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
  model: ResultDatasetBrowserModel;
  itemsPage: AnalysisResultItemPageResource | null;
  selectedDatasetId: string | null;
  samplesPage: AnalysisResultSamplePageResource | null;
  axisFilters: Readonly<Record<string, string>>;
  axisValues: AnalysisResultAxisValuesResource | null;
  datasetSearch: string;
  itemFieldFilter: "all" | "true" | "false";
  itemSort: string;
  onSelect: (selection: AnalysisResultSelectionRef) => void;
  onDatasetSearchChange: (value: string) => void;
  onAxisFilterChange: (axisId: string, token: string | null) => void;
  onBranchPageChange: (cursor: string | null) => void;
  onItemFieldFilterChange: (value: "all" | "true" | "false") => void;
  onItemPageChange: (cursor: string | null) => void;
  onItemSortChange: (value: string) => void;
  onSamplePageChange: (cursor: string | null) => void;
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

export function ResultDatasetBrowser({
  manifest,
  branchesPage,
  model,
  itemsPage,
  onSelect,
  onItemPageChange,
  onSamplePageChange,
  datasetSearch,
  itemFieldFilter,
  itemSort,
  onDatasetSearchChange,
  onItemFieldFilterChange,
  onItemSortChange,
  onAxisFilterChange,
  onBranchPageChange,
  axisFilters,
  axisValues,
  samplesPage,
  selectedDatasetId,
}: ResultDatasetBrowserProps) {
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
            <span>{model.datasets.length}</span>
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
              No published result datasets.
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
                    data-status={dataset.status}
                    onClick={() => onSelect(datasetSelection(dataset))}
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
        </nav>

        <div className="fm-results-dataset-browser__detail">
          {!manifest ? (
            <p className="fm-results-dataset-browser__empty">
              Select a dataset to inspect its axes and result items.
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
                <span data-status={model.manifestStatus}>
                  {manifest.status.completeness}
                </span>
              </header>

              <div className="fm-results-dataset-browser__axes" aria-label="Dataset axes">
                {model.axes.map((axis) => {
                  const axisResource = manifest.axes.find(
                    (candidate) => candidate.axis_id === axis.axisId,
                  );
                  const filterable = Boolean(
                    axisResource &&
                      [
                        "outer_sweep",
                        "parameter",
                        "material",
                        "geometry",
                        "field",
                      ].includes(axisResource.role),
                  );
                  const values =
                    filterable && axisResource?.inline_values
                      ? axisResource.inline_values
                      : filterable && axisValues?.axis_id === axis.axisId
                        ? axisValues.values
                        : [];
                  return (
                    <div className="fm-results-dataset-browser__axis" key={axis.axisId}>
                      <div className="fm-results-dataset-browser__axis-heading">
                        <span>
                          {axis.label}: {axis.cardinality}
                          {axis.unit ? ` ${axis.unit}` : ""}
                        </span>
                        <small>Role: {axis.role}</small>
                        {values.length > 0 ? (
                          <Select
                            onValueChange={(value) =>
                              onAxisFilterChange(
                                axis.axisId,
                                value === "__all__" ? null : value,
                              )
                            }
                            value={axisFilters[axis.axisId] ?? "__all__"}
                          >
                            <SelectTrigger aria-label={`${axis.label} value`}>
                              <SelectValue placeholder="All values" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__all__">All values</SelectItem>
                              {values.map((value) => (
                                <SelectItem key={value.token} value={value.token}>
                                  {value.label ?? value.token}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <small>Values are paged by the server</small>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="fm-results-dataset-browser__filters" aria-label="Result filters">
                <label className="fm-results-dataset-browser__filter-label">
                  Item order
                  <Select onValueChange={onItemSortChange} value={itemSort}>
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
                  {branchesPage?.unsupported_reason ? (
                    <p className="fm-results-dataset-browser__empty">
                      {branchesPage.unsupported_reason}
                    </p>
                  ) : model.branches.length === 0 ? (
                    <p className="fm-results-dataset-browser__empty">
                      No tracked branch page loaded.
                    </p>
                  ) : (
                    <VirtualizedResultRows
                      ariaLabel="Result branch page"
                      items={model.branches}
                      itemKey={(branch) => branch.branchId}
                    >
                      {(branch) => (
                        <button
                          className="fm-results-dataset-browser__row"
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
                  {model.samples.length === 0 ? (
                    <p className="fm-results-dataset-browser__empty">No sample page loaded.</p>
                  ) : (
                    <VirtualizedResultRows
                      ariaLabel="Result sample page"
                      items={model.samples}
                      itemKey={(sample) => sample.sampleId}
                    >
                      {(sample) => (
                        <button
                          className="fm-results-dataset-browser__row"
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
                  {model.items.length === 0 ? (
                    <p className="fm-results-dataset-browser__empty">No item page loaded.</p>
                  ) : (
                    <VirtualizedResultRows
                      ariaLabel="Result item page"
                      items={model.items}
                      itemKey={(item) => item.itemId}
                    >
                      {(item) => (
                        <button
                          className="fm-results-dataset-browser__row"
                          data-status={item.status}
                          onClick={() =>
                            onSelect(
                              analysisResultSelectionRef({
                                datasetId: manifest.dataset_id,
                                datasetRevision: manifest.dataset_revision,
                                fieldId: item.fieldId ?? undefined,
                                focus: "item",
                                itemId: item.itemId,
                                itemKind: item.itemKindCode,
                                runId: manifest.run_id,
                                sampleId: item.sampleId,
                                stageId: manifest.stage_id,
                              }),
                            )
                          }
                          type="button"
                        >
                          <span>{item.label}</span>
                          <small>{item.itemKind} · {formatResultFrequency(item.frequencyHz)}</small>
                          <small>
                            {item.branchId ? `branch ${item.branchId} · ` : ""}
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
  // TanStack Virtual exposes an imperative measurement API by design.
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: items.length,
    estimateSize: () => 72,
    getScrollElement: () => parentRef.current,
    overscan: 6,
  });

  return (
    <div
      aria-label={ariaLabel}
      className="fm-results-dataset-browser__virtual-list"
      ref={parentRef}
      role="list"
    >
      <div
        className="fm-results-dataset-browser__virtual-list-inner"
        style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const item = items[virtualRow.index];
          if (!item) return null;
          return (
            <div
              className="fm-results-dataset-browser__virtual-row"
              data-index={virtualRow.index}
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
