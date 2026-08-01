"use client";

import { useCallback, useMemo } from "react";

import type { HysteresisPointSchema } from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";
import {
  clearHysteresisPointSelectionForLive,
  hysteresisPointVectorResourceRef,
  hysteresisPointTargetMetadata,
} from "@/shared/domain/study/HysteresisChart";
import { Button } from "@/shared/ui/Button";

import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorGroup } from "../../../primitives/InspectorGroup";
import {
  hysteresisInitialStateActionPresentation,
  hysteresisReplayActionPresentation,
} from "./HysteresisInspectorUtils";
import type { HysteresisInspectorCommonProps } from "./HysteresisInspectorTypes";

export function HysteresisPointDetailInspector({
  activePoint,
  kernel,
  pointDetail,
  points,
  progress,
  stageId,
  targetMetadata,
}: Pick<
  HysteresisInspectorCommonProps,
  "activePoint" | "kernel" | "points" | "progress" | "stageId" | "targetMetadata"
> & {
  pointDetail: HysteresisPointSchema | null | undefined;
}) {
  const commandContext = useMemo(
    () => createCommandContext("inspector", kernel),
    [kernel],
  );
  const selectedPoint =
    activePoint?.pointId != null
      ? pointDetail ??
        points.find((point) => point.point_id === activePoint.pointId) ??
        null
      : null;
  const returnToLive = useCallback(() => {
    if (stageId) {
      clearHysteresisPointSelectionForLive(kernel, stageId, "inspector");
    }
    kernel.commands.execute("hysteresis.return-to-live", commandContext, {
      stageId: stageId ?? null,
    });
  }, [commandContext, kernel, stageId]);
  const loadPointIn3D = useCallback(
    (point: HysteresisPointSchema) => {
      if (!stageId) return;
      const metadata = hysteresisPointTargetMetadata(point, targetMetadata);
      kernel.commands.execute("hysteresis.load-point-in-3d", commandContext, {
        stageId,
        pointId: point.point_id,
        fieldVal: point.field_value_mT,
        mVal: point.m_parallel,
        snapshotId: point.snapshot_id ?? null,
        snapshotResourceRef: hysteresisPointVectorResourceRef(point),
        snapshotStorageStatus: point.snapshot_storage_status ?? null,
        snapshotStorageReason: point.snapshot_storage_reason ?? null,
        meshIdentity: metadata.meshIdentity ?? null,
        fieldOrientation: metadata.fieldOrientation ?? null,
        measurementAxis: metadata.measurementAxis ?? null,
        fieldRevision: metadata.fieldRevision ?? null,
      });
    },
    [commandContext, kernel, stageId, targetMetadata],
  );
  const usePointAsInitialState = useCallback(
    (point: HysteresisPointSchema) => {
      if (!stageId || !point.snapshot_id) return;
      kernel.commands.execute("hysteresis.use-point-as-initial-state", commandContext, {
        stageId,
        snapshotId: point.snapshot_id,
        snapshotArtifactRef: point.snapshot_json_artifact_ref ?? null,
        snapshotResourceRef: point.snapshot_resource_ref ?? null,
      });
    },
    [commandContext, kernel, stageId],
  );

  return (
    <InspectorGroup
      title="Field Point"
      badge={
        selectedPoint
          ? `${selectedPoint.field_value_mT.toFixed(2)} mT`
          : activePoint?.pointId != null
            ? `point ${activePoint.pointId}`
            : "select point"
      }
    >
      {selectedPoint ? (
        <HysteresisPointDetail
          activeSnapshotId={activePoint?.snapshotId ?? null}
          onLoadPointIn3D={loadPointIn3D}
          onReturnToLive={returnToLive}
          onUsePointAsInitialState={usePointAsInitialState}
          point={selectedPoint}
        />
      ) : activePoint?.pointId != null ? (
        <div className="fm-hysteresis-inspector-empty">
          Point {activePoint.pointId} is selected, but its calculated point
          record is not available yet.
        </div>
      ) : progress?.active && progress.active_point_index != null ? (
        <div className="fm-hysteresis-inspector-empty">
          Calculating point {progress.active_point_index + 1}
          {progress.current_field_mT != null
            ? ` at ${progress.current_field_mT.toFixed(3)} mT`
            : ""}.
        </div>
      ) : (
        <div className="fm-hysteresis-inspector-empty">
          Select a hysteresis field point to inspect its field, magnetization,
          convergence, and saved snapshot.
        </div>
      )}
    </InspectorGroup>
  );
}

function HysteresisPointDetail({
  activeSnapshotId,
  onLoadPointIn3D,
  onReturnToLive,
  onUsePointAsInitialState,
  point,
}: {
  activeSnapshotId: string | null;
  onLoadPointIn3D: (point: HysteresisPointSchema) => void;
  onReturnToLive: () => void;
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
  const snapshotLoaded =
    activeSnapshotId != null && activeSnapshotId === point.snapshot_id;
  return (
    <>
      <FieldRow label="Point" value={String(point.point_id)} />
      <FieldRow
        label="Field"
        value={point.field_value_mT.toFixed(3)}
        unit="mT"
      />
      <FieldRow label="M_parallel" value={point.m_parallel.toFixed(6)} />
      <FieldRow label="M_oop" value={point.m_oop.toFixed(6)} />
      <FieldRow label="M_ip" value={point.m_ip.toFixed(6)} />
      <FieldRow
        label="M_avg"
        value={point.m_avg.map((value) => value.toFixed(6)).join(", ")}
      />
      <FieldRow label="Status" value={point.settle_status ?? point.status} />
      {point.terminal_settle_reason && (
        <FieldRow label="Stop reason" value={point.terminal_settle_reason} />
      )}
      {point.warning_count != null && point.warning_count > 0 && (
        <FieldRow label="Warnings" value={String(point.warning_count)} />
      )}
      <FieldRow label="Snapshot" value={point.snapshot_id ?? "not saved"} />
      {point.snapshot_storage_status && (
        <FieldRow label="Snapshot status" value={point.snapshot_storage_status} />
      )}
      {point.snapshot_storage_reason && (
        <FieldRow label="Snapshot detail" value={point.snapshot_storage_reason} />
      )}
      <div className="fm-hysteresis-inspector-actions">
        <Button
          size="sm"
          variant="secondary"
          disabled={replayAction.disabled}
          onClick={() => onLoadPointIn3D(point)}
          title={replayAction.title}
        >
          Load 3D
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={initialStateAction.disabled}
          onClick={() => onUsePointAsInitialState(point)}
          title={initialStateAction.title}
        >
          Use as initial
        </Button>
        {snapshotLoaded && (
          <Button
            size="sm"
            variant="secondary"
            onClick={onReturnToLive}
            title="Return the 3D viewport to the live magnetization field"
          >
            Return to live
          </Button>
        )}
      </div>
    </>
  );
}
