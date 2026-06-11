"use client";

import { useMemo } from "react";

import type { HysteresisPointSchema } from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";

import { HysteresisChart } from "@/shared/domain/study/HysteresisChart";
import { Button } from "@/shared/ui/Button";

import { InspectorSection } from "../../../primitives/InspectorSection";
import { hysteresisInitialStateActionPresentation } from "./HysteresisInspectorUtils";
import type { HysteresisInspectorCommonProps } from "./HysteresisInspectorTypes";

export function HysteresisPointsInspector({
  kernel,
  points,
  progress,
  stageId,
  targetMetadata,
}: Pick<
  HysteresisInspectorCommonProps,
  "kernel" | "points" | "progress" | "stageId" | "targetMetadata"
>) {
  const commandContext = useMemo(
    () => createCommandContext("inspector", kernel),
    [kernel],
  );
  const loadPointIn3D = (pt: HysteresisPointSchema) => {
    if (!stageId) return;
    kernel.commands.execute("hysteresis.load-point-in-3d", commandContext, {
      stageId,
      pointId: pt.point_id,
      fieldVal: pt.field_value_mT,
      mVal: pt.m_parallel,
      snapshotId: pt.snapshot_id ?? null,
      meshIdentity: targetMetadata.meshIdentity ?? null,
      fieldOrientation: targetMetadata.fieldOrientation ?? null,
      measurementAxis: targetMetadata.measurementAxis ?? null,
      fieldRevision: targetMetadata.fieldRevision ?? null,
    });
  };

  const usePointAsInitialState = (pt: HysteresisPointSchema) => {
    if (!stageId || !pt.snapshot_id) return;
    kernel.commands.execute("hysteresis.use-point-as-initial-state", commandContext, {
      stageId,
      snapshotId: pt.snapshot_id,
      snapshotResourceRef: pt.snapshot_resource_ref ?? null,
    });
  };
  const completedPoints = progress?.completed_points ?? 0;
  const hasMissingHistory = points.length === 0 && completedPoints > 0;

  return (
    <InspectorSection
      value="hysteresis-points"
      title="Hysteresis Points"
      badge={
        progress?.total_points != null
          ? `${points.length} / ${progress.total_points} done`
          : `${points.length} points`
      }
    >
      {stageId ? (
        <HysteresisChart commandSource="inspector" kernel={kernel} stageId={stageId} />
      ) : null}
      {points.length > 0 ? (
        <div className="fm-hysteresis-inspector-table-wrap">
          <table className="fm-hysteresis-inspector-table">
            <thead>
              <tr>
                <th>Index</th>
                <th>Field (mT)</th>
                <th>M_parallel</th>
                <th>Settle</th>
                <th className="fm-hysteresis-inspector-table__actions-heading">Actions</th>
              </tr>
            </thead>
            <tbody>
              {points.map((pt) => (
                <HysteresisPointRow
                  key={pt.point_id}
                  point={pt}
                  onLoadPointIn3D={loadPointIn3D}
                  onUsePointAsInitialState={usePointAsInitialState}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="fm-hysteresis-inspector-empty">
          {hasMissingHistory
            ? `Hysteresis progress reports ${completedPoints} completed ${
                completedPoints === 1 ? "point" : "points"
              }, but no point history is available.`
            : progress?.active && progress.active_point_index != null && progress.total_points != null
            ? `Calculating point ${progress.active_point_index + 1} / ${progress.total_points}${
                progress.current_field_mT != null
                  ? ` at ${progress.current_field_mT.toFixed(3)} mT`
                  : ""
              }.`
            : "No calculated points available."}
        </div>
      )}
    </InspectorSection>
  );
}

function HysteresisPointRow({
  onLoadPointIn3D,
  onUsePointAsInitialState,
  point,
}: {
  onLoadPointIn3D: (point: HysteresisPointSchema) => void;
  onUsePointAsInitialState: (point: HysteresisPointSchema) => void;
  point: HysteresisPointSchema;
}) {
  const initialStateAction = hysteresisInitialStateActionPresentation(point.snapshot_id);
  const settleLabel = point.settle_status ?? point.status;
  const warningLabel =
    point.warning_count != null && point.warning_count > 0
      ? `${point.warning_count} ${point.warning_count === 1 ? "warning" : "warnings"}`
      : null;
  return (
    <tr data-status={point.status}>
      <td>{point.point_id}</td>
      <td>{point.field_value_mT.toFixed(2)}</td>
      <td>{point.m_parallel.toFixed(5)}</td>
      <td>{warningLabel ? `${settleLabel} (${warningLabel})` : settleLabel}</td>
      <td className="fm-hysteresis-inspector-table__actions">
        <Button
          size="sm"
          variant="secondary"
          disabled={!point.snapshot_id}
          onClick={() => onLoadPointIn3D(point)}
          title={point.snapshot_id ? "Load point magnetization in 3D viewport" : "Snapshot not saved for this point"}
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
      </td>
    </tr>
  );
}
