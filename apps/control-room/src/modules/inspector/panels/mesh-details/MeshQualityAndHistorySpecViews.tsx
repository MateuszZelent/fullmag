"use client";

import type { ReactNode } from "react";

import { meshHistoryRestoreTarget } from "@/kernel/authoring/meshBuildHistoryRestore";
import {
  ScientificEChart,
  type ResolvedChartThemePalette,
} from "@/shared/charts/ScientificEChart";
import {
  meshBuildHistoryComparisonForSelection,
  type MeshBuildHistoryComparisonRow,
  type MeshBuildHistoryEntry,
} from "@/shared/domain/mesh/meshBuildHistory";
import type { MeshEditorCapabilityModel } from "@/shared/domain/mesh/meshEditorCapabilityModel";
import type { MeshQualityRefinementState } from "@/shared/domain/mesh/meshQualityRefinement";
import type {
  MeshQualityHistogramBin,
  MeshQualityMetric,
  MeshQualityStatistics,
  MeshSizeDistribution,
  MeshWorstElement,
} from "@/shared/domain/mesh/qualityStatistics";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { keyedOccurrences } from "@/shared/utils/keyedOccurrences";

import { buildMeshSizeDistributionHoverBin } from "../meshHistogramHoverState";
import type { MeshSizeDistributionHoverBin } from "../MeshQualityChart";
import { asRecord, formatLength, formatValue, recordField } from "../MeshResourceView";
import { meshDetailKey } from "./meshDetailsSectionUtils";
import type {
  MixedCertificateFamilyGate,
  MixedCertificateQualityPresentation,
} from "./MeshQualityGatesSection.model";
import type { MixedTopologyPresentation } from "./MixedTopologyProvenanceSection.model";

export function formatCountClean(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toLocaleString("en-US");
  }
  return "Not published";
}

export function sanitizeMeshDisplayText(value: unknown, fallback = "Not published"): string {
  if (value === null || value === undefined) return fallback;
  const raw = typeof value === "string" ? value.trim() : formatValue(value);
  if (!raw) return fallback;
  if (/^(?:unknown|unavailable|n\/a|not\s+available|unresolved)$/i.test(raw)) {
    return fallback;
  }
  return raw
    .replace(/\bunknown\b/gi, "not published")
    .replace(/\bunavailable\b/gi, "not published");
}

function formatPercentClean(value: number | null): string {
  return value === null || !Number.isFinite(value)
    ? "—"
    : `${(value * 100).toPrecision(3)}%`;
}

function formatCountPercentClean(count: number | null, total: number | null): string {
  if (count === null || total === null || total <= 0) return "—";
  return formatPercentClean(count / total);
}

function histogramTotal(histogram: readonly MeshQualityHistogramBin[]): number | null {
  const total = histogram.reduce((sum, bin) => sum + bin.count, 0);
  return total > 0 ? total : null;
}

function estimateBelowThresholdCount(metric: MeshQualityMetric): number | null {
  const threshold = metric.threshold;
  if (threshold === null) return null;
  const count = metric.histogram.reduce((sum, bin) => {
    if (bin.lo === null || bin.hi === null) return sum;
    if (bin.hi <= threshold) return sum + bin.count;
    if (bin.lo >= threshold) return sum;
    const width = bin.hi - bin.lo;
    if (width <= 0) return sum;
    const overlap = (threshold - bin.lo) / width;
    return sum + Math.round(bin.count * Math.max(0, Math.min(1, overlap)));
  }, 0);
  return count > 0 ? count : null;
}

function metricTargetSplit(
  metric: MeshQualityMetric,
  elementCount: number | null,
): {
  belowCount: number | null;
  meetsCount: number | null;
  total: number | null;
} {
  const total = elementCount ?? histogramTotal(metric.histogram);
  const belowCount = metric.belowThresholdCount ?? estimateBelowThresholdCount(metric);
  const meetsCount =
    belowCount !== null && total !== null ? Math.max(total - belowCount, 0) : null;
  return { belowCount, meetsCount, total };
}

function metricSummaryText(metric: MeshQualityMetric): string {
  return [
    `min ${formatValue(metric.min)}`,
    metric.p05 === null ? null : `p05 ${formatValue(metric.p05)}`,
    `mean ${formatValue(metric.mean)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function formatDistributionScalar(
  distribution: MeshSizeDistribution,
  value: number | null,
): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return distribution.id === "edge_length" || distribution.id === "tetra_size"
    ? formatLength(value)
    : formatValue(value);
}

function buildMetricHistogramOption(metric: MeshQualityMetric) {
  return (palette: ResolvedChartThemePalette) => {
    const threshold = metric.threshold;
    const labels = metric.histogram.map((bin) => bin.label);
    const values = metric.histogram.map((bin) => {
      const below =
        threshold !== null && bin.hi !== null && bin.hi <= threshold;
      return {
        itemStyle: {
          color: below ? palette.danger : palette.accent,
        },
        value: bin.count,
      };
    });
    return {
      animation: false,
      grid: { bottom: 28, left: 42, right: 14, top: 16 },
      series: [
        {
          data: values,
          name: metric.label,
          type: "bar" as const,
        },
      ],
      tooltip: {
        backgroundColor: palette.tooltipBackground,
        borderColor: palette.borderSubtle,
        textStyle: { color: palette.textPrimary, fontSize: palette.fontSize },
        trigger: "axis" as const,
      },
      xAxis: {
        axisLabel: { color: palette.textMuted, fontSize: palette.fontSize },
        data: labels,
        type: "category" as const,
      },
      yAxis: {
        axisLabel: { color: palette.textMuted, fontSize: palette.fontSize },
        splitLine: { lineStyle: { color: palette.borderSubtle } },
        type: "value" as const,
      },
    };
  };
}

function buildSizeDistributionOption(distribution: MeshSizeDistribution) {
  return (palette: ResolvedChartThemePalette) => ({
    animation: false,
    grid: { bottom: 28, left: 42, right: 14, top: 16 },
    series: [
      {
        data: distribution.histogram.map((bin) => ({
          itemStyle: { color: palette.accent },
          value: bin.count,
        })),
        name: distribution.label,
        type: "bar" as const,
      },
    ],
    tooltip: {
      backgroundColor: palette.tooltipBackground,
      borderColor: palette.borderSubtle,
      textStyle: { color: palette.textPrimary, fontSize: palette.fontSize },
      trigger: "axis" as const,
    },
    xAxis: {
      axisLabel: { color: palette.textMuted, fontSize: palette.fontSize },
      data: distribution.histogram.map((bin) => bin.label),
      type: "category" as const,
    },
    yAxis: {
      axisLabel: { color: palette.textMuted, fontSize: palette.fontSize },
      splitLine: { lineStyle: { color: palette.borderSubtle } },
      type: "value" as const,
    },
  });
}

export function QualityGatesSpecView({
  checks,
  gates,
  mixedCertificate,
}: {
  checks: readonly { id: string; status: "pass" | "warn" | "failed"; value: string }[];
  gates: readonly MixedCertificateFamilyGate[];
  mixedCertificate: MixedCertificateQualityPresentation;
}): ReactNode {
  return (
    <div className="fm-inspector-stack">
      {checks.length > 0 ? (
        <div
          aria-label="Global quality gates"
          className="fm-mesh-detail-table"
          role="table"
        >
          <div className="fm-mesh-detail-table__row" role="row">
            <span role="columnheader">Check</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Value</span>
          </div>
          {checks.map((check) => (
            <div
              key={check.id}
              className="fm-mesh-detail-table__row fm-mesh-gate-row"
              data-status={check.status}
              role="row"
            >
              <span role="cell">{check.id}</span>
              <span role="cell">{check.status}</span>
              <span role="cell">{sanitizeMeshDisplayText(check.value, "—")}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="fm-mesh-empty" role="note">
          No global quality-gate checks published yet.
        </p>
      )}

      <div className="fm-inspector-stack">
        <div className="flex items-center justify-between gap-2">
          <strong>Mixed certificate quality</strong>
          <Badge
            variant={
              mixedCertificate.status === "valid"
                ? "success"
                : mixedCertificate.status === "rejected"
                  ? "danger"
                  : "warning"
            }
          >
            {sanitizeMeshDisplayText(mixedCertificate.status, "pending")}
          </Badge>
        </div>
        {mixedCertificate.status !== "valid" ? (
          <p className="fm-mesh-empty" role="note">
            Mixed certificate evidence ({sanitizeMeshDisplayText(mixedCertificate.status, "pending")}):{" "}
            {sanitizeMeshDisplayText(mixedCertificate.reason, "awaiting mesh qualification")}
          </p>
        ) : null}
      </div>

      {gates.length > 0 ? (
        <div
          aria-label="Mixed-topology family quality gates"
          className="fm-mesh-detail-table"
          role="table"
        >
          <div className="fm-mesh-detail-table__row" role="row">
            <span role="columnheader">Family / metric</span>
            <span role="columnheader">p05 / threshold</span>
            <span role="columnheader">Jacobian</span>
          </div>
          {gates.map((gate) => (
            <div
              key={`${gate.family}:${gate.metric}`}
              className="fm-mesh-detail-table__row fm-mesh-gate-row"
              data-status={gate.status}
              role="row"
            >
              <span role="cell">
                {gate.family} · {gate.metric}
              </span>
              <span role="cell">
                {gate.p05.toFixed(3)} / {gate.threshold.toFixed(3)} · {gate.status}
              </span>
              <span role="cell">
                {gate.positiveJacobian ? "det J > 0" : "det J <= 0"} (
                {gate.minimumJacobianM3.toExponential(2)} m³)
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function MeshQualityStatisticsSpecView({
  activeMetricFilter,
  onHoverSizeDistributionBin,
  onRefineWorstElement,
  onSelectMetric,
  onSelectWorstElement,
  refinementState,
  statistics,
}: {
  activeMetricFilter?: string;
  onHoverSizeDistributionBin?: (bin: MeshSizeDistributionHoverBin | null) => void;
  onRefineWorstElement?: () => void;
  onSelectMetric?: (metric: MeshQualityMetric["id"]) => void;
  onSelectWorstElement?: (element: MeshWorstElement) => void;
  refinementState?: MeshQualityRefinementState;
  statistics: MeshQualityStatistics | null;
}): ReactNode {
  if (!statistics) {
    return (
      <p className="fm-mesh-empty" role="note">
        No mesh quality statistics published for the current build.
      </p>
    );
  }

  const visibleMetrics =
    activeMetricFilter && activeMetricFilter !== "all"
      ? statistics.metrics.filter((m) => m.id === activeMetricFilter)
      : statistics.metrics;
  const metricsToRender =
    visibleMetrics.length > 0 ? visibleMetrics : statistics.metrics;

  return (
    <div className="fm-mesh-quality-view grid min-w-0 gap-3">
      {metricsToRender.length > 0 ? (
        <div className="fm-mesh-quality-metrics grid min-w-0 gap-3">
          {metricsToRender.map((metric) => {
            const split = metricTargetSplit(metric, statistics.elementCount);
            return (
              <section className="fm-mesh-quality-metric grid min-w-0 gap-2" key={metric.id}>
                <div className="fm-mesh-quality-metric__header flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h4>{metric.label}</h4>
                    <span>{metricSummaryText(metric)}</span>
                  </div>
                  {onSelectMetric ? (
                    <Button
                      data-metric-id={metric.id}
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={() => onSelectMetric(metric.id)}
                    >
                      Show heatmap
                    </Button>
                  ) : null}
                </div>

                {split.belowCount !== null || split.meetsCount !== null ? (
                  <div className="fm-mesh-quality-band-grid">
                    <div className="fm-mesh-quality-band" data-status="warning">
                      <span>Below target</span>
                      <strong>{formatCountClean(split.belowCount)}</strong>
                      <small>{formatCountPercentClean(split.belowCount, split.total)}</small>
                    </div>
                    <div className="fm-mesh-quality-band" data-status="ready">
                      <span>Meets target</span>
                      <strong>{formatCountClean(split.meetsCount)}</strong>
                      <small>{formatCountPercentClean(split.meetsCount, split.total)}</small>
                    </div>
                  </div>
                ) : null}

                {metric.histogram.length > 0 ? (
                  <ScientificEChart
                    ariaLabel={`FEM element quality histogram (${metric.id})`}
                    height={176}
                    optionBuilder={buildMetricHistogramOption(metric)}
                  />
                ) : (
                  <p className="fm-mesh-empty" role="note">
                    Scalar {metric.label} bounds published without bin histogram.
                  </p>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <p className="fm-mesh-empty" role="note">
          No SICN or gamma histograms published for the current build.
        </p>
      )}

      {statistics.sizeDistributions.length > 0 ? (
        <section className="fm-mesh-size-distributions grid min-w-0 gap-3">
          <div className="fm-mesh-size-distributions__header">
            <h4>Element size distributions</h4>
            <span>
              Hover or select a size bin to highlight matching elements in the 3D viewport.
            </span>
          </div>
          {statistics.sizeDistributions.map((distribution) => (
            <section
              className="fm-mesh-size-distribution grid min-w-0 gap-2"
              data-distribution={distribution.id}
              key={distribution.id}
              onMouseLeave={() => onHoverSizeDistributionBin?.(null)}
            >
              <div className="fm-mesh-size-distribution__header flex flex-wrap items-center justify-between gap-2">
                <h4>{distribution.label}</h4>
                <span>
                  min {formatDistributionScalar(distribution, distribution.min)} · mean{" "}
                  {formatDistributionScalar(distribution, distribution.mean)} · max{" "}
                  {formatDistributionScalar(distribution, distribution.max)}
                </span>
              </div>
              {distribution.histogram.length > 0 ? (
                <>
                  <ScientificEChart
                    ariaLabel={`${distribution.label} distribution histogram`}
                    height={148}
                    optionBuilder={buildSizeDistributionOption(distribution)}
                    onPointSelect={({ dataIndex }) => {
                      if (!onHoverSizeDistributionBin) return;
                      onHoverSizeDistributionBin(
                        buildMeshSizeDistributionHoverBin(distribution, dataIndex),
                      );
                    }}
                  />
                  <ul
                    aria-label={`${distribution.label} histogram bins`}
                    className="fm-mesh-size-distribution__bins"
                  >
                    {keyedOccurrences(distribution.histogram, (bin) => bin.label).map(
                      ({ item: bin, key }, index) => (
                        <li
                          key={key}
                          onBlur={() => onHoverSizeDistributionBin?.(null)}
                          onFocus={() =>
                            onHoverSizeDistributionBin?.(
                              buildMeshSizeDistributionHoverBin(distribution, index),
                            )
                          }
                          onMouseEnter={() =>
                            onHoverSizeDistributionBin?.(
                              buildMeshSizeDistributionHoverBin(distribution, index),
                            )
                          }
                        >
                          <span>{bin.label}</span>
                          <strong>{formatCountClean(bin.count)}</strong>
                        </li>
                      ),
                    )}
                  </ul>
                </>
              ) : (
                <p className="fm-mesh-size-distribution__empty">
                  Scalar range published without size-bin histogram.
                </p>
              )}
            </section>
          ))}
        </section>
      ) : null}

      {statistics.warnings.length > 0 ? (
        <ul className="fm-mesh-quality-warnings">
          {statistics.warnings.map((warning) => (
            <li key={warning}>{sanitizeMeshDisplayText(warning)}</li>
          ))}
        </ul>
      ) : null}

      {refinementState ? (
        <section
          className="fm-mesh-quality-refinement flex flex-wrap items-center justify-between gap-2"
          data-status={refinementState.status}
        >
          <div>
            <h4>Quality refinement</h4>
            <p>{sanitizeMeshDisplayText(refinementState.reason, "Ready for local refinement")}</p>
          </div>
          {refinementState.plan && onRefineWorstElement ? (
            <Button
              data-element-index={refinementState.plan.elementIndex}
              size="sm"
              type="button"
              variant="secondary"
              onClick={onRefineWorstElement}
            >
              Refine worst region
            </Button>
          ) : null}
        </section>
      ) : null}

      <section className="fm-mesh-quality-worst grid min-w-0 gap-2">
        <h4>Worst elements</h4>
        {statistics.worstElements.length > 0 ? (
          <div className="fm-mesh-detail-list">
            {statistics.worstElements.map((element) => {
              const key = `${element.elementIndex}:${element.scopeLabel}`;
              const content = (
                <>
                  <strong>Element {element.elementIndex}</strong>
                  <span>{sanitizeMeshDisplayText(element.scopeLabel, "shared-domain")}</span>
                  <small>
                    gamma {formatValue(element.gamma)} · SICN {formatValue(element.sicn)} · volume{" "}
                    {formatValue(element.volume)}
                  </small>
                </>
              );
              return onSelectWorstElement ? (
                <Button
                  key={key}
                  className="fm-mesh-detail-list__item h-auto w-full items-stretch justify-start"
                  data-element-index={element.elementIndex}
                  data-status="warning"
                  type="button"
                  variant="ghost"
                  onClick={() => onSelectWorstElement(element)}
                >
                  {content}
                </Button>
              ) : (
                <div
                  key={key}
                  className="fm-mesh-detail-list__item"
                  data-status="warning"
                >
                  {content}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="fm-mesh-empty" role="note">
            No per-element worst list published for the current build.
          </p>
        )}
      </section>
    </div>
  );
}

function formatBuildDelta(value: number | null): string {
  if (value === null) return "baseline";
  if (value > 0) return `+${value.toLocaleString("en-US")}`;
  return value.toLocaleString("en-US");
}

function formatBuildQualitySummary(entry: MeshBuildHistoryEntry): string {
  const parts = [
    entry.sicnP05 === null ? null : `SICN p05 ${formatValue(entry.sicnP05)}`,
    entry.gammaMin === null ? null : `gamma min ${formatValue(entry.gammaMin)}`,
    entry.avgQuality === null ? null : `avg ${formatValue(entry.avgQuality)}`,
  ].filter(Boolean);
  return parts.join(" / ") || "quality metrics pending";
}

export function MeshBuildComparisonTableView({
  rows,
}: {
  rows: readonly MeshBuildHistoryComparisonRow[];
}): ReactNode {
  if (rows.length === 0) return null;
  return (
    <table className="fm-mesh-build-comparison">
      <thead>
        <tr className="fm-mesh-build-comparison__row">
          <th scope="col">Metric</th>
          <th scope="col">Before</th>
          <th scope="col">After</th>
          <th scope="col">Delta</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr className="fm-mesh-build-comparison__row" key={row.id}>
            <th scope="row">{row.label}</th>
            <td>{row.before === null ? "unset" : formatValue(row.before)}</td>
            <td>{row.after === null ? "unset" : formatValue(row.after)}</td>
            <td>{formatBuildDelta(row.delta)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function MeshBuildHistorySpecView({
  beforeId,
  afterId,
  entries,
  onRestore,
}: {
  beforeId?: string;
  afterId?: string;
  entries: readonly MeshBuildHistoryEntry[];
  onRestore?: (entry: MeshBuildHistoryEntry) => void;
}): ReactNode {
  if (entries.length === 0) {
    return (
      <p className="fm-mesh-empty" role="note">
        No mesh build history entries recorded yet.
      </p>
    );
  }

  const mutableEntries = [...entries];
  const resolvedBefore =
    beforeId && mutableEntries.some((e) => e.id === beforeId)
      ? beforeId
      : mutableEntries[0]?.id;
  const resolvedAfter =
    afterId && mutableEntries.some((e) => e.id === afterId)
      ? afterId
      : mutableEntries.at(-1)?.id;
  const comparison =
    resolvedBefore && resolvedAfter && mutableEntries.length >= 2
      ? meshBuildHistoryComparisonForSelection(mutableEntries, {
          afterId: resolvedAfter,
          beforeId: resolvedBefore,
        })
      : null;

  return (
    <div className="fm-mesh-build-history grid min-w-0 gap-3">
      {comparison ? (
        <section className="fm-mesh-build-history__comparison grid min-w-0 gap-2">
          <div className="flex items-center justify-between gap-2">
            <strong>
              Build #{comparison.beforeIndex + 1} vs Build #{comparison.afterIndex + 1}
            </strong>
          </div>
          <MeshBuildComparisonTableView rows={comparison.rows} />
        </section>
      ) : null}

      <div className="fm-mesh-detail-list">
        {[...mutableEntries].reverse().map((entry) => {
          const restoreTarget = meshHistoryRestoreTarget(entry);
          const reason =
            entry.meshReason ??
            entry.kind ??
            entry.generationMode ??
            entry.meshTarget ??
            "build";
          return (
            <div
              key={entry.id}
              className="fm-mesh-detail-list__item"
              data-build-id={entry.id}
              data-status={entry.deltaElementCount === null ? "baseline" : "ready"}
            >
              <strong>
                #{entry.index + 1} {entry.meshName ?? "shared-domain mesh"}
              </strong>
              <span>
                nodes {formatBuildDelta(entry.deltaNodeCount)} · elements{" "}
                {formatBuildDelta(entry.deltaElementCount)}
              </span>
              <small>
                {formatCountClean(entry.nodeCount)} nodes ·{" "}
                {formatCountClean(entry.elementCount)} elements ·{" "}
                {sanitizeMeshDisplayText(reason, "build")} ·{" "}
                {formatBuildQualitySummary(entry)}
                {entry.qualityDataAvailable ? " · FMMQ" : ""}
              </small>
              <small>
                build {entry.buildId ?? entry.id} · command{" "}
                {entry.commandId ?? "direct"}
                {entry.meshTarget ? ` · target ${entry.meshTarget}` : ""}
                {entry.durationSeconds !== null
                  ? ` · ${formatValue(entry.durationSeconds)} s`
                  : ""}
              </small>
              {entry.restorable && restoreTarget && onRestore ? (
                <div className="pt-1">
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => onRestore(entry)}
                  >
                    {restoreTarget === "universe"
                      ? "Restore Airbox policy to draft"
                      : "Restore object policy to draft"}
                  </Button>
                </div>
              ) : entry.restoreReason === "snapshot-unavailable" ? (
                <small>Configuration snapshot not recorded for this entry.</small>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ThinFilmDiagnosticsSpecView({
  diagnostics,
}: {
  diagnostics: readonly unknown[];
}): ReactNode {
  if (diagnostics.length === 0) {
    return (
      <p className="fm-mesh-empty" role="note">
        No thin-film diagnostics present in the active build report.
      </p>
    );
  }
  return (
    <div className="fm-mesh-detail-list">
      {diagnostics.map((diagnosticEntry, index) => {
        const record = asRecord(diagnosticEntry);
        const actualMethod = recordField(record, "actual_method");
        const geometryName = recordField(record, "geometry_name");
        const lateralSize = recordField(record, "lateral_size");
        const requestedMethod = recordField(record, "requested_method");
        const thickness = recordField(record, "thickness");
        const warnings = recordField(record, "warnings");
        const warnList = Array.isArray(warnings)
          ? warnings.map((w) => sanitizeMeshDisplayText(w, "")).filter(Boolean)
          : [];
        return (
          <div
            key={meshDetailKey("thin-film", [
              geometryName,
              actualMethod,
              requestedMethod,
              thickness,
              lateralSize,
              index,
            ])}
            className="fm-mesh-detail-list__item"
            data-status={warnList.length > 0 ? "warning" : "ready"}
          >
            <strong>{sanitizeMeshDisplayText(geometryName, `Film ${index + 1}`)}</strong>
            <span>{sanitizeMeshDisplayText(actualMethod ?? requestedMethod, "auto")}</span>
            <small>
              thickness {formatLength(thickness)} · lateral {formatLength(lateralSize)}
              {warnList.length > 0 ? ` · ${warnList.join("; ")}` : ""}
            </small>
          </div>
        );
      })}
    </div>
  );
}

export function OperationStatusesSpecView({
  operationStatuses,
}: {
  operationStatuses: readonly unknown[];
}): ReactNode {
  if (operationStatuses.length === 0) {
    return (
      <p className="fm-mesh-empty" role="note">
        No operation statuses recorded in the active build report.
      </p>
    );
  }
  return (
    <div className="fm-mesh-detail-list">
      {operationStatuses.map((statusEntry, index) => {
        const record = asRecord(statusEntry);
        const kind = recordField(record, "kind");
        const reason = recordField(record, "reason");
        const scope = recordField(record, "scope");
        const status = recordField(record, "status");
        return (
          <div
            key={meshDetailKey("op-status", [kind, scope, index])}
            className="fm-mesh-detail-list__item"
            data-status={sanitizeMeshDisplayText(status, "ready")}
          >
            <strong>{sanitizeMeshDisplayText(kind, `Operation ${index + 1}`)}</strong>
            <span>{sanitizeMeshDisplayText(status, "recorded")}</span>
            <small>{sanitizeMeshDisplayText(reason ?? scope, "shared-domain")}</small>
          </div>
        );
      })}
    </div>
  );
}

export function MixedTopologyProvenanceSpecView({
  model,
}: {
  model: MixedTopologyPresentation;
}): ReactNode {
  const rejected = model.certificateStatus === "rejected";
  const orphanRejected = model.topologyIntegrity === "rejected";
  const rows: Array<{ label: string; value: string }> = [
    { label: "Requested topology", value: sanitizeMeshDisplayText(model.requestedTopology) },
    { label: "Resolved topology", value: sanitizeMeshDisplayText(model.resolvedTopology) },
    {
      label: "Requested element layers",
      value: sanitizeMeshDisplayText(model.requestedLayers),
    },
    {
      label: "Resolved element layers",
      value: sanitizeMeshDisplayText(model.resolvedLayers),
    },
    {
      label: "Requested exact layers",
      value: sanitizeMeshDisplayText(model.requestedExactLayers),
    },
    {
      label: "Resolved exact layers",
      value: sanitizeMeshDisplayText(model.resolvedExactLayers),
    },
    { label: "Node planes", value: sanitizeMeshDisplayText(model.nodePlanes) },
    { label: "Transition policy", value: sanitizeMeshDisplayText(model.transitionPolicy) },
    { label: "Certificate status", value: sanitizeMeshDisplayText(model.certificateStatus) },
    {
      label: "Certificate fingerprint",
      value: sanitizeMeshDisplayText(model.certificateFingerprint),
    },
    { label: "Fallback", value: sanitizeMeshDisplayText(model.fallback) },
    { label: "Topology schema", value: sanitizeMeshDisplayText(model.topologySchemaVersion) },
    { label: "Gmsh version", value: sanitizeMeshDisplayText(model.gmshVersion) },
    {
      label: "Orphan entities",
      value:
        model.orphanEntities.length > 0
          ? model.orphanEntities
              .map(({ dimension, tag }) => `dim ${dimension} tag ${tag}`)
              .join("; ")
          : "None",
    },
    ...model.regionFields.map((f) => ({
      label: f.label,
      value: sanitizeMeshDisplayText(f.value),
    })),
    ...model.elementCounts.map(({ family, count }) => ({
      label: `Family ${family}`,
      value: formatCountClean(count),
    })),
    ...model.facetCounts.map(({ familyAndRole, count }) => ({
      label: `Facet ${familyAndRole}`,
      value: formatCountClean(count),
    })),
  ];

  return (
    <div className="fm-inspector-stack">
      {rejected ? (
        <p className="fm-mesh-empty" role="alert">
          Exact-layer certificate rejected: {sanitizeMeshDisplayText(model.certificateReason)}
        </p>
      ) : null}
      {orphanRejected ? (
        <p className="fm-mesh-empty" role="alert">
          Orphan topology entities invalidate this mixed mesh; execution fails closed.
        </p>
      ) : null}
      {model.rejection ? (
        <div className="fm-mesh-detail-list">
          <div className="fm-mesh-detail-list__item" data-status="failed">
            <strong>Mixed-P1 request rejected ({sanitizeMeshDisplayText(model.rejection.category)})</strong>
            <span>{sanitizeMeshDisplayText(model.rejection.reason)}</span>
            <small>
              Requested {sanitizeMeshDisplayText(model.rejection.requestedExecution)} → Resolved{" "}
              {sanitizeMeshDisplayText(model.rejection.resolvedExecution)} · Alternative:{" "}
              {sanitizeMeshDisplayText(model.rejection.alternative)}
            </small>
          </div>
        </div>
      ) : null}
      <div className="fm-mesh-detail-table" role="table" aria-label="Mixed topology provenance">
        {rows.map((row) => (
          <div key={row.label} className="fm-mesh-detail-table__row" role="row">
            <span role="cell">{row.label}</span>
            <span role="cell">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const CAPABILITY_LABELS: Record<string, string> = {
  cpu: "CPU execution",
  double: "Double precision",
  fdm: "FDM structured mesh",
  fem: "FEM tetrahedral/mixed mesh",
  gpu: "CUDA GPU execution",
  multilayer: "Multilayer Z-stack",
  pbc: "Periodic boundary conditions",
  single: "Single precision",
};

export function MeshEditorCapabilitiesSpecView({
  model,
}: {
  model: MeshEditorCapabilityModel;
}): ReactNode {
  return (
    <div className="fm-mesh-detail-table" role="table" aria-label="Mesh editor capabilities">
      {model.options.map((option) => {
        const statusText = option.enabled
          ? option.status === "supported"
            ? "Supported"
            : sanitizeMeshDisplayText(option.status, "Supported")
          : "Blocked";
        return (
          <div key={option.id} className="fm-mesh-detail-table__row" role="row">
            <span role="cell">{CAPABILITY_LABELS[option.id] ?? option.id}</span>
            <span role="cell">
              {statusText}
              {option.reason ? ` — ${sanitizeMeshDisplayText(option.reason)}` : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}
