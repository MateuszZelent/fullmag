"use client";

import { useCallback, useMemo } from "react";

import type { HysteresisPointSchema } from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";

import {
  clearHysteresisPointSelectionForLive,
  HysteresisChart,
  hysteresisPointVectorResourceRef,
  hysteresisPointTargetMetadata,
} from "@/shared/domain/study/HysteresisChart";
import { Button } from "@/shared/ui/Button";

import { InspectorSection } from "../../../primitives/InspectorSection";
import type { HysteresisInspectorCommonProps } from "./HysteresisInspectorTypes";
import { HysteresisPointTable } from "./HysteresisPointTable";

export function HysteresisPointsInspector({
  activeSnapshot,
  kernel,
  points,
  progress,
  stageId,
  targetMetadata,
}: Pick<
  HysteresisInspectorCommonProps,
  | "activeSnapshot"
  | "kernel"
  | "points"
  | "progress"
  | "stageId"
  | "targetMetadata"
>) {
  const commandContext = useMemo(
    () => createCommandContext("inspector", kernel),
    [kernel],
  );
  const returnToLive = useCallback(() => {
    if (stageId) {
      clearHysteresisPointSelectionForLive(kernel, stageId, "inspector");
    }
    kernel.commands.execute("hysteresis.return-to-live", commandContext, {
      stageId: stageId ?? null,
    });
  }, [commandContext, kernel, stageId]);

  const loadPointIn3D = (pt: HysteresisPointSchema) => {
    if (!stageId) return;
    const pointTargetMetadata = hysteresisPointTargetMetadata(pt, targetMetadata);
    kernel.commands.execute("hysteresis.load-point-in-3d", commandContext, {
      stageId,
      pointId: pt.point_id,
      fieldVal: pt.field_value_mT,
      mVal: pt.m_parallel,
      snapshotId: pt.snapshot_id ?? null,
      snapshotResourceRef: hysteresisPointVectorResourceRef(pt),
      snapshotStorageStatus: pt.snapshot_storage_status ?? null,
      snapshotStorageReason: pt.snapshot_storage_reason ?? null,
      meshIdentity: pointTargetMetadata.meshIdentity ?? null,
      fieldOrientation: pointTargetMetadata.fieldOrientation ?? null,
      measurementAxis: pointTargetMetadata.measurementAxis ?? null,
      fieldRevision: pointTargetMetadata.fieldRevision ?? null,
    });
  };

  const usePointAsInitialState = (pt: HysteresisPointSchema) => {
    if (!stageId || !pt.snapshot_id) return;
    kernel.commands.execute("hysteresis.use-point-as-initial-state", commandContext, {
      stageId,
      snapshotId: pt.snapshot_id,
      snapshotArtifactRef: pt.snapshot_json_artifact_ref ?? null,
      snapshotResourceRef: pt.snapshot_resource_ref ?? null,
    });
  };
  const runPointCommand = (
    commandId:
      | "hysteresis.bookmark-point"
      | "hysteresis.compare-point"
      | "hysteresis.export-point-csv",
    pt: HysteresisPointSchema,
  ) => {
    if (!stageId) return;
    kernel.commands.execute(commandId, commandContext, {
      point: pt,
      stageId,
    });
  };
  const exportLoopCsv = useCallback(() => {
    if (!stageId) return;
    kernel.commands.execute("hysteresis.export-loop-csv", commandContext, {
      points,
      stageId,
    });
  }, [commandContext, kernel, points, stageId]);
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
      <div className="fm-hysteresis-inspector-actions">
        <Button
          size="sm"
          variant="secondary"
          disabled={points.length === 0}
          onClick={exportLoopCsv}
          title={
            points.length > 0
              ? "Export the calculated hysteresis points as CSV"
              : "No hysteresis points are available to export"
          }
        >
          Export loop CSV
        </Button>
      </div>
      {activeSnapshot && (
        <div className="fm-hysteresis-inspector-live-snapshot">
          <div className="fm-hysteresis-inspector-live-snapshot__body">
            <span className="fm-hysteresis-inspector-live-snapshot__label">
              3D viewport state
            </span>
            <span>
              Snapshot {activeSnapshot.snapshotId}
              {activeSnapshot.pointId != null
                ? ` | Point ${activeSnapshot.pointId}${
                    activeSnapshot.fieldValueMt != null
                      ? ` at ${activeSnapshot.fieldValueMt.toFixed(3)} mT`
                      : ""
                  }`
                : ""}
            </span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={returnToLive}
            title="Return the 3D viewport to the live magnetization field"
          >
            Return to live
          </Button>
        </div>
      )}
      {points.length > 0 ? (
        <HysteresisPointTable
          onBookmarkPoint={(pt) => runPointCommand("hysteresis.bookmark-point", pt)}
          onComparePoint={(pt) => runPointCommand("hysteresis.compare-point", pt)}
          onExportPoint={(pt) => runPointCommand("hysteresis.export-point-csv", pt)}
          onLoadPointIn3D={loadPointIn3D}
          onUsePointAsInitialState={usePointAsInitialState}
          points={points}
        />
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
