import type { CSSProperties } from "react";

import type {
  MeshQualityHistogramBin,
  MeshQualityMetric,
  MeshSizeDistribution,
  MeshQualityStatistics,
  MeshWorstElement,
} from "@/shared/domain/mesh/qualityStatistics";
import type { MeshQualityRefinementState } from "@/shared/domain/mesh/meshQualityRefinement";

import {
  formatCount,
  formatLength,
  formatValue,
  MeshResourceEmpty,
} from "./MeshResourceView";

function metricSummary(metric: MeshQualityMetric): string {
  const parts = [
    `min ${formatValue(metric.min)}`,
    metric.p05 === null ? null : `p05 ${formatValue(metric.p05)}`,
    `mean ${formatValue(metric.mean)}`,
  ].filter(Boolean);
  return parts.join(" / ");
}

function formatPercent(value: number | null): string {
  return value === null ? "unknown" : `${(value * 100).toPrecision(3)}%`;
}

function formatCountPercent(count: number | null, total: number | null): string {
  if (count === null || total === null || total <= 0) return "unknown";
  return formatPercent(count / total);
}

function histogramTotal(histogram: MeshQualityHistogramBin[]): number | null {
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
  const belowCount =
    metric.belowThresholdCount ?? estimateBelowThresholdCount(metric);
  const meetsCount =
    belowCount !== null && total !== null ? Math.max(total - belowCount, 0) : null;
  return { belowCount, meetsCount, total };
}

function belowThresholdSummary(
  metric: MeshQualityMetric,
  elementCount: number | null,
): string | null {
  if (
    metric.belowThresholdCount === null &&
    metric.threshold === null &&
    metric.belowThresholdFraction === null
  ) {
    return null;
  }
  return `Below target ${formatCount(metric.belowThresholdCount)} / ${formatCount(
    elementCount,
  )} below ${formatValue(metric.threshold)} (${formatPercent(
    metric.belowThresholdFraction,
  )})`;
}

function formatDistributionValue(
  distribution: MeshSizeDistribution,
  value: number | null,
): string {
  if (value === null) return "unknown";
  return distribution.id === "edge_length" ? formatLength(value) : formatValue(value);
}

function SizeDistributionCard({
  distribution,
}: {
  distribution: MeshSizeDistribution;
}) {
  const hasHistogram = distribution.histogram.length > 0;
  return (
    <section className="fm-mesh-size-distribution">
      <div className="fm-mesh-size-distribution__header">
        <h4>{distribution.label}</h4>
        <span>
          min {formatDistributionValue(distribution, distribution.min)} / mean{" "}
          {formatDistributionValue(distribution, distribution.mean)} / max{" "}
          {formatDistributionValue(distribution, distribution.max)}
        </span>
      </div>
      <dl className="fm-mesh-size-distribution__stats">
        <div>
          <dt>Std</dt>
          <dd>{formatDistributionValue(distribution, distribution.std)}</dd>
        </div>
        {distribution.ratio !== null ? (
          <div>
            <dt>Ratio</dt>
            <dd>{formatValue(distribution.ratio)}</dd>
          </div>
        ) : null}
      </dl>
      {hasHistogram ? (
        <div className="fm-mesh-quality-histogram" role="list">
          {distribution.histogram.map((bin) => (
            <div
              className="fm-mesh-quality-histogram__bin"
              key={`${distribution.id}:${bin.label}`}
              role="listitem"
              style={
                {
                  "--fm-mesh-quality-bin": `${Math.round(bin.fraction * 100)}%`,
                } as CSSProperties
              }
            >
              <span>{bin.label}</span>
              <strong>{bin.count.toLocaleString("en-US")}</strong>
            </div>
          ))}
        </div>
      ) : (
        <p className="fm-mesh-size-distribution__empty">
          No size-bin histogram is published; showing scalar range only.
        </p>
      )}
    </section>
  );
}

export function MeshQualityStatisticsView({
  onRefineWorstElement,
  onSelectMetric,
  onSelectWorstElement,
  refinementState,
  statistics,
}: {
  onRefineWorstElement?: () => void;
  onSelectMetric?: (metric: MeshQualityMetric["id"]) => void;
  onSelectWorstElement?: (element: MeshWorstElement) => void;
  refinementState?: MeshQualityRefinementState;
  statistics: MeshQualityStatistics | null;
}) {
  if (!statistics) {
    return <MeshResourceEmpty label="No mesh quality statistics are available." />;
  }

  return (
    <div className="fm-mesh-quality-view">
      <dl className="fm-mesh-quality-summary">
        <div>
          <dt>Source</dt>
          <dd>{statistics.qualitySource ?? "unknown"}</dd>
        </div>
        <div>
          <dt>Elements</dt>
          <dd>{formatCount(statistics.elementCount)}</dd>
        </div>
        <div>
          <dt>Volume ratio</dt>
          <dd>{formatValue(statistics.volumeRatio)}</dd>
        </div>
        <div>
          <dt>Mean edge</dt>
          <dd>{formatValue(statistics.edgeLength?.mean)}</dd>
        </div>
      </dl>

      {statistics.metrics.length > 0 ? (
        <div className="fm-mesh-quality-metrics">
          {statistics.metrics.map((metric) => {
            const thresholdSummary = belowThresholdSummary(
              metric,
              statistics.elementCount,
            );
            const split = metricTargetSplit(metric, statistics.elementCount);
            return (
              <section className="fm-mesh-quality-metric" key={metric.id}>
                <div className="fm-mesh-quality-metric__header">
                  <h4>{metric.label}</h4>
                  <span>{metricSummary(metric)}</span>
                  {thresholdSummary ? (
                    <span className="fm-mesh-quality-metric__threshold">
                      {thresholdSummary}
                    </span>
                  ) : null}
                  {onSelectMetric ? (
                    <button
                      className="fm-mesh-quality-metric__action"
                      data-metric-id={metric.id}
                      onClick={() => onSelectMetric(metric.id)}
                      type="button"
                    >
                      Show heatmap
                    </button>
                  ) : null}
                </div>
                {split.belowCount !== null || split.meetsCount !== null ? (
                  <div className="fm-mesh-quality-band-grid">
                    <div className="fm-mesh-quality-band" data-status="warning">
                      <span>Below target</span>
                      <strong>{formatCount(split.belowCount)}</strong>
                      <small>
                        {formatCountPercent(split.belowCount, split.total)}
                      </small>
                    </div>
                    <div className="fm-mesh-quality-band" data-status="ready">
                      <span>Meets target</span>
                      <strong>{formatCount(split.meetsCount)}</strong>
                      <small>
                        {formatCountPercent(split.meetsCount, split.total)}
                      </small>
                    </div>
                  </div>
                ) : null}
                <div className="fm-mesh-quality-histogram" role="list">
                  {metric.histogram.map((bin) => (
                    <div
                      className="fm-mesh-quality-histogram__bin"
                      key={`${metric.id}:${bin.label}`}
                      role="listitem"
                      style={
                        {
                          "--fm-mesh-quality-bin": `${Math.round(bin.fraction * 100)}%`,
                        } as CSSProperties
                      }
                    >
                      <span>{bin.label}</span>
                      <strong>{bin.count.toLocaleString("en-US")}</strong>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <MeshResourceEmpty label="No SICN or gamma histograms are available." />
      )}

      {statistics.sizeDistributions.length > 0 ? (
        <section className="fm-mesh-size-distributions">
          <div className="fm-mesh-size-distributions__header">
            <h4>Element size distributions</h4>
            <span>Published edge-length and volume bins from the mesh report.</span>
          </div>
          {statistics.sizeDistributions.map((distribution) => (
            <SizeDistributionCard
              distribution={distribution}
              key={distribution.id}
            />
          ))}
        </section>
      ) : (
        <MeshResourceEmpty label="No element-size distributions are available." />
      )}

      {statistics.warnings.length > 0 ? (
        <ul className="fm-mesh-quality-warnings">
          {statistics.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      {refinementState ? (
        <section
          className="fm-mesh-quality-refinement"
          data-status={refinementState.status}
        >
          <div>
            <h4>Quality refinement</h4>
            <p>{refinementState.reason}</p>
          </div>
          {refinementState.plan && onRefineWorstElement ? (
            <button
              className="fm-mesh-quality-refinement__action"
              data-element-index={refinementState.plan.elementIndex}
              onClick={onRefineWorstElement}
              type="button"
            >
              Refine worst region
            </button>
          ) : null}
        </section>
      ) : null}

      <section className="fm-mesh-quality-worst">
        <h4>Worst elements</h4>
        {statistics.worstElements.length > 0 ? (
          <div className="fm-mesh-detail-list">
            {statistics.worstElements.map((element) => {
              const content = (
                <>
                  <strong>Element {element.elementIndex}</strong>
                  <span>{element.scopeLabel}</span>
                  <small>
                    gamma {formatValue(element.gamma)} / SICN {formatValue(element.sicn)} / volume{" "}
                    {formatValue(element.volume)}
                  </small>
                </>
              );
              const key = `${element.elementIndex}:${element.scopeLabel}`;
              return onSelectWorstElement ? (
                <button
                  className="fm-mesh-detail-list__item"
                  data-element-index={element.elementIndex}
                  data-status="warning"
                  key={key}
                  onClick={() => onSelectWorstElement(element)}
                  type="button"
                >
                  {content}
                </button>
              ) : (
                <div
                  className="fm-mesh-detail-list__item"
                  data-status="warning"
                  key={key}
                >
                  {content}
                </div>
              );
            })}
          </div>
        ) : (
          <MeshResourceEmpty label="No per-element worst list is available." />
        )}
      </section>
    </div>
  );
}
