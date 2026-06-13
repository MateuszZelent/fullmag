"use client";

import type { HysteresisPointSchema } from "@/kernel/api/apiTypes";
import { Button } from "@/shared/ui/Button";

import {
  hysteresisInitialStateActionPresentation,
  hysteresisReplayActionPresentation,
} from "./HysteresisInspectorUtils";

interface HysteresisPointTableProps {
  onBookmarkPoint: (point: HysteresisPointSchema) => void;
  onComparePoint: (point: HysteresisPointSchema) => void;
  onExportPoint: (point: HysteresisPointSchema) => void;
  onLoadPointIn3D: (point: HysteresisPointSchema) => void;
  onUsePointAsInitialState: (point: HysteresisPointSchema) => void;
  points: HysteresisPointSchema[];
}

export function HysteresisPointTable({
  onBookmarkPoint,
  onComparePoint,
  onExportPoint,
  onLoadPointIn3D,
  onUsePointAsInitialState,
  points,
}: HysteresisPointTableProps) {
  return (
    <div className="fm-hysteresis-inspector-table-wrap">
      <table className="fm-hysteresis-inspector-table">
        <thead>
          <tr>
            <th>Point</th>
            <th>Role</th>
            <th>Branch</th>
            <th>Source</th>
            <th>H (mT)</th>
            <th>Angle</th>
            <th>M_parallel</th>
            <th>M_oop</th>
            <th>M_ip</th>
            <th>M_x</th>
            <th>M_y</th>
            <th>M_z</th>
            <th>Settle / Status</th>
            <th>Snapshot</th>
            <th className="fm-hysteresis-inspector-table__actions-heading">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <HysteresisPointTableRow
              key={point.point_id}
              onBookmarkPoint={onBookmarkPoint}
              onComparePoint={onComparePoint}
              onExportPoint={onExportPoint}
              onLoadPointIn3D={onLoadPointIn3D}
              onUsePointAsInitialState={onUsePointAsInitialState}
              point={point}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HysteresisPointTableRow({
  onBookmarkPoint,
  onComparePoint,
  onExportPoint,
  onLoadPointIn3D,
  onUsePointAsInitialState,
  point,
}: {
  onBookmarkPoint: (point: HysteresisPointSchema) => void;
  onComparePoint: (point: HysteresisPointSchema) => void;
  onExportPoint: (point: HysteresisPointSchema) => void;
  onLoadPointIn3D: (point: HysteresisPointSchema) => void;
  onUsePointAsInitialState: (point: HysteresisPointSchema) => void;
  point: HysteresisPointSchema;
}) {
  const replayAction = hysteresisReplayActionPresentation(
    point.snapshot_id,
    point.snapshot_storage_status,
    point.snapshot_storage_reason,
  );
  const initialStateAction = hysteresisInitialStateActionPresentation(
    point.snapshot_id,
    point.snapshot_storage_status,
    point.snapshot_storage_reason,
  );
  const settleLabel = point.settle_status ?? point.status;
  const warningLabel =
    point.warning_count != null && point.warning_count > 0
      ? `${point.warning_count} ${point.warning_count === 1 ? "warning" : "warnings"}`
      : null;
  const refinementReason = point.refinement_reason?.join(", ");
  const mAvg = point.m_avg ?? [];

  return (
    <tr data-status={point.status}>
      <td>{point.point_id}</td>
      <td>{point.protocol_role ?? "n/a"}</td>
      <td>{point.branch_id ?? point.branch_ids?.join(", ") ?? "n/a"}</td>
      <td>
        {point.adaptive_inserted ? (
          <span
            className="fm-hysteresis-inspector-point-source"
            title={
              refinementReason
                ? `Adaptive refinement: ${refinementReason}`
                : "Adaptive refinement"
            }
          >
            Adaptive
          </span>
        ) : (
          "Planned"
        )}
      </td>
      <td>{point.field_value_mT.toFixed(2)}</td>
      <td>{formatFieldOrientation(point.field_orientation)}</td>
      <td>{formatScalar(point.m_parallel)}</td>
      <td>{formatScalar(point.m_oop)}</td>
      <td>{formatScalar(point.m_ip)}</td>
      <td>{formatVectorComponent(mAvg, 0)}</td>
      <td>{formatVectorComponent(mAvg, 1)}</td>
      <td>{formatVectorComponent(mAvg, 2)}</td>
      <td>{warningLabel ? `${settleLabel} (${warningLabel})` : settleLabel}</td>
      <td>{point.snapshot_storage_status ?? (point.snapshot_id ? "available" : "none")}</td>
      <td className="fm-hysteresis-inspector-table__actions">
        <Button
          size="sm"
          variant="secondary"
          disabled={replayAction.disabled}
          onClick={() => onLoadPointIn3D(point)}
          title={replayAction.title}
          className="fm-hysteresis-inspector-action"
        >
          3D
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={initialStateAction.disabled}
          onClick={() => onUsePointAsInitialState(point)}
          title={initialStateAction.title}
          className="fm-hysteresis-inspector-action"
        >
          Init
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => onComparePoint(point)}
          title="Select this point in the hysteresis chart for comparison."
          className="fm-hysteresis-inspector-action"
        >
          Compare
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => onBookmarkPoint(point)}
          title="Bookmark this point in the browser session."
          className="fm-hysteresis-inspector-action"
        >
          Bookmark
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => onExportPoint(point)}
          title="Export this point as a CSV file."
          className="fm-hysteresis-inspector-action"
        >
          Export
        </Button>
      </td>
    </tr>
  );
}

function formatScalar(value: number): string {
  return value.toFixed(5);
}

function formatVectorComponent(values: number[], index: number): string {
  const value = values[index];
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(5)
    : "n/a";
}

function formatFieldOrientation(value: unknown): string {
  if (!value || typeof value !== "object") return "n/a";
  const orientation = value as {
    kind?: unknown;
    preset_name?: unknown;
    theta_deg?: unknown;
    phi_deg?: unknown;
  };
  if (typeof orientation.preset_name === "string") {
    return orientation.preset_name;
  }
  if (
    typeof orientation.theta_deg === "number" &&
    typeof orientation.phi_deg === "number"
  ) {
    return `theta ${orientation.theta_deg.toFixed(1)} deg, phi ${orientation.phi_deg.toFixed(1)} deg`;
  }
  if (typeof orientation.kind === "string") {
    return orientation.kind;
  }
  return "custom";
}
