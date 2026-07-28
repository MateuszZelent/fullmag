"use client";

import { useEffect, useId, useRef } from "react";

import type { ChartRenderModel, ChartRenderSeries } from "./chartRenderer";
import { formatAxisValue } from "./scientificChartFormatting";

const MAX_ROWS = 500;

interface PointsTableDialogProps {
  model: ChartRenderModel;
  /** Controlled open state */
  open: boolean;
  onClose: () => void;
}

/**
 * PointsTableDialog — accessible, bounded replacement for ECharts `dataView`.
 *
 * Rules:
 * - Shows at most MAX_ROWS rows per series (with a truncation notice).
 * - Accessible: dialog role, focus trap, Escape to close, ARIA labels.
 * - No ECharts instance or Canvas dependency.
 * - Numeric values use formatAxisValue (SI prefix); units shown in column headers.
 * - Data is provenance-stamped (revision, decimation, trust).
 */
export function PointsTableDialog({ model, open, onClose }: PointsTableDialogProps) {
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
          <SeriesTable key={series.id} series={series} xAxis={model.xAxis} />
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
}: {
  series: ChartRenderSeries;
  xAxis: { label: string; unit: string };
}) {
  const truncated = series.points.length > MAX_ROWS;
  const points = truncated ? series.points.slice(0, MAX_ROWS) : series.points;
  const xLabel = xAxis.unit ? `${xAxis.label} [${xAxis.unit}]` : xAxis.label;
  const yLabel = series.unit ? `${series.label} [${series.unit}]` : series.label;

  return (
    <div className="fm-points-table-dialog__series">
      <h3 className="fm-points-table-dialog__series-title">
        {series.label}
        {series.unit ? <span className="fm-points-table-dialog__series-unit"> [{series.unit}]</span> : null}
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
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.rowIndex}>
                <td>{point.rowIndex}</td>
                <td className="fm-points-table-dialog__numeric">
                  {formatAxisValue(point.x, 5)}
                </td>
                <td className="fm-points-table-dialog__numeric">
                  {formatAxisValue(point.y, 5)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
