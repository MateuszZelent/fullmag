"use client";

import type { HysteresisPointSchema } from "@/kernel/api/apiTypes";
import { Button } from "@/shared/ui/Button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/shared/ui/Tooltip";

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
    <tr className="tabular-nums" data-status={point.status}>
      <td>{point.point_id}</td>
      <td>{point.protocol_role ?? "n/a"}</td>
      <td>{point.branch_id ?? point.branch_ids?.join(", ") ?? "n/a"}</td>
      <td>
        {point.adaptive_inserted ? (
          <TooltipProvider delayDuration={250}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  aria-label={
                    refinementReason
                      ? `Adaptive refinement: ${refinementReason}`
                      : "Adaptive refinement"
                  }
                  className="fm-hysteresis-inspector-point-source"
                >
                  Adaptive
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {refinementReason
                  ? `Adaptive refinement: ${refinementReason}`
                  : "Adaptive refinement"}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
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
          disabledReason={replayAction.title}
          onClick={() => onLoadPointIn3D(point)}
          className="fm-hysteresis-inspector-action"
        >
          3D
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={initialStateAction.disabled}
          disabledReason={initialStateAction.title}
          onClick={() => onUsePointAsInitialState(point)}
          className="fm-hysteresis-inspector-action"
        >
          Init
        </Button>
        <Button
          aria-label={`Select point ${point.point_id} for comparison`}
          size="sm"
          variant="secondary"
          onClick={() => onComparePoint(point)}
          className="fm-hysteresis-inspector-action"
        >
          Compare
        </Button>
        <Button
          aria-label={`Bookmark point ${point.point_id}`}
          size="sm"
          variant="secondary"
          onClick={() => onBookmarkPoint(point)}
          className="fm-hysteresis-inspector-action"
        >
          Bookmark
        </Button>
        <Button
          aria-label={`Export point ${point.point_id} as CSV`}
          size="sm"
          variant="secondary"
          onClick={() => onExportPoint(point)}
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
