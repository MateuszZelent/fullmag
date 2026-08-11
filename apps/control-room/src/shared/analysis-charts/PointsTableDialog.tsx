"use client";

import { useEffect, useId, useRef } from "react";

import type { ChartRenderModel, ChartRenderSeries } from "./chartRenderer";
import {
  chartAxisName,
  chartValueExtrema,
  createChartDisplayTransform,
  createChartYAxisDisplayTransforms,
  formatChartDisplayValue,
  type ChartDisplayTransform,
} from "./chartScalePolicy";
import { parseLabelAndUnit } from "./scientificChartFormatting";

const MAX_ROWS = 500;

interface PointsTableDialogProps {
  model: ChartRenderModel;
  /** Controlled open state */
  open: boolean;
  onClose: () => void;
  onPointSelected?: (seriesId: string, pointIndex: number) => void;
}

/**
 * PointsTableDialog — accessible, bounded replacement for ECharts `dataView`.
 *
 * Rules:
 * - Shows at most MAX_ROWS rows per series (with a truncation notice).
 * - Accessible: dialog role, focus trap, Escape to close, ARIA labels.
 * - No ECharts instance or Canvas dependency.
 * - Numeric values and units use the same dimension-aware transform as the canvas.
 * - Data is provenance-stamped (revision, decimation, trust).
 */
export function PointsTableDialog({
  model,
  open,
  onClose,
  onPointSelected,
}: PointsTableDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal();
    } else {
      if (dialog.open) dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleClose = () => onClose();
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, [onClose]);

  if (!open) return null;

  const provenance = model.provenance;
  const isStaleOrDegraded = model.status === "stale" || model.status === "degraded";
  const xTransform = createChartDisplayTransform(
    model.xAxis.unit,
    chartValueExtrema(iterateXValues(model.series)),
  );
  const yTransforms = createChartYAxisDisplayTransforms(model.yAxes, model.series);

  return (
    <dialog
      aria-describedby={descId}
      aria-labelledby={titleId}
      className="fm-points-table-dialog"
      ref={dialogRef}
    >
      <div className="fm-points-table-dialog__header">
        <h2 className="fm-points-table-dialog__title" id={titleId}>
          {model.ariaLabel}
        </h2>
        <button
          aria-label="Close points table"
          className="fm-points-table-dialog__close"
          onClick={onClose}
          type="button"
        >
          ✕
        </button>
      </div>

      <div className="fm-points-table-dialog__provenance" id={descId}>
        {provenance ? (
          <dl className="fm-points-table-dialog__meta">
            <dt>Revision</dt>
            <dd>{provenance.dataRevision ?? "—"}</dd>
            <dt>Decimation</dt>
            <dd>{provenance.decimation}</dd>
            <dt>Query</dt>
            <dd className="fm-points-table-dialog__query">{provenance.query}</dd>
          </dl>
        ) : null}
        {isStaleOrDegraded ? (
          <div
            className="fm-points-table-dialog__trust-warning"
            role="alert"
          >
            ⚠ Data is {model.status} — values may not reflect the latest revision.
          </div>
        ) : null}
      </div>

      <div className="fm-points-table-dialog__body">
        {model.series.map((series) => (
          <SeriesTable
            key={series.id}
            series={series}
            xAxis={model.xAxis}
            xTransform={xTransform}
            yAxis={model.yAxes[series.yAxis] ?? {
              label: series.label,
              unit: series.unit,
            }}
            yTransform={yTransforms[series.yAxis] ?? createChartDisplayTransform(series.unit, null)}
            onPointSelected={onPointSelected}
          />
        ))}
        {model.series.length === 0 ? (
          <p className="fm-points-table-dialog__empty">No data points.</p>
        ) : null}
      </div>

      <div className="fm-points-table-dialog__footer">
        <button
          className="fm-points-table-dialog__close-btn"
          onClick={onClose}
          type="button"
        >
          Close
        </button>
      </div>
    </dialog>
  );
}

function SeriesTable({
  series,
  xAxis,
  xTransform,
  yAxis,
  yTransform,
  onPointSelected,
}: {
  series: ChartRenderSeries;
  xAxis: { label: string; unit: string };
  xTransform: ChartDisplayTransform;
  yAxis: { label: string; unit: string };
  yTransform: ChartDisplayTransform;
  onPointSelected?: (seriesId: string, pointIndex: number) => void;
}) {
  const truncated = series.points.length > MAX_ROWS;
  const points = truncated ? series.points.slice(0, MAX_ROWS) : series.points;
  const xLabel = chartAxisName(
    parseLabelAndUnit(xAxis.label, xAxis.unit).baseLabel,
    xTransform,
  );
  const yLabel = chartAxisName(
    parseLabelAndUnit(yAxis.label, yAxis.unit).baseLabel,
    yTransform,
  );

  return (
    <div className="fm-points-table-dialog__series">
      <h3 className="fm-points-table-dialog__series-title">
        {series.label}
        {yTransform.displayUnit ? (
          <span className="fm-points-table-dialog__series-unit">
            {` [${yTransform.displayUnit}]`}
          </span>
        ) : null}
      </h3>
      {truncated ? (
        <p
          aria-live="polite"
          className="fm-points-table-dialog__truncation"
          role="status"
        >
          Showing first {MAX_ROWS} of {series.points.length} points.
        </p>
      ) : null}
      <div className="fm-points-table-dialog__table-scroll">
        <table className="fm-points-table-dialog__table">
          <caption className="fm-visually-hidden">
            {series.label} data — {series.points.length} points
          </caption>
          <thead>
            <tr>
              <th scope="col">Row</th>
              <th scope="col">{xLabel}</th>
              <th scope="col">{yLabel}</th>
              {onPointSelected ? <th scope="col">Action</th> : null}
            </tr>
          </thead>
          <tbody>
            {points.map((point, pointIndex) => (
              <tr key={point.rowIndex}>
                <td>{point.rowIndex}</td>
                <td className="fm-points-table-dialog__numeric">
                  {formatChartDisplayValue(point.x, xTransform)}
                </td>
                <td className="fm-points-table-dialog__numeric">
                  {formatChartDisplayValue(point.y, yTransform)}
                </td>
                {onPointSelected ? (
                  <td>
                    <button
                      aria-label={`Select ${series.label} row ${point.rowIndex}`}
                      className="fm-points-table-dialog__select-point"
                      type="button"
                      onClick={() => onPointSelected(series.id, pointIndex)}
                    >
                      Select
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function* iterateXValues(
  series: readonly ChartRenderSeries[],
): Iterable<number> {
  for (const entry of series) {
    for (const point of entry.points) yield point.x;
  }
}
