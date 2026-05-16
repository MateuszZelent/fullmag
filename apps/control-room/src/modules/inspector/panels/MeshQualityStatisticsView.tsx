import type { CSSProperties } from "react";

import type {
  MeshQualityMetric,
  MeshQualityStatistics,
  MeshWorstElement,
} from "@/shared/domain/mesh/qualityStatistics";

import {
  formatCount,
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

export function MeshQualityStatisticsView({
  onSelectWorstElement,
  statistics,
}: {
  onSelectWorstElement?: (element: MeshWorstElement) => void;
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
          {statistics.metrics.map((metric) => (
            <section className="fm-mesh-quality-metric" key={metric.id}>
              <div className="fm-mesh-quality-metric__header">
                <h4>{metric.label}</h4>
                <span>{metricSummary(metric)}</span>
              </div>
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
          ))}
        </div>
      ) : (
        <MeshResourceEmpty label="No SICN or gamma histograms are available." />
      )}

      {statistics.warnings.length > 0 ? (
        <ul className="fm-mesh-quality-warnings">
          {statistics.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
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
