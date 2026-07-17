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
  parseJsonRecord,
} from "./HysteresisInspectorUtils";
import type { HysteresisInspectorCommonProps } from "./HysteresisInspectorTypes";

export function HysteresisSnapshotsInspector({
  activeSnapshot,
  draft,
  kernel,
  points,
  stageId,
  targetMetadata,
}: Pick<
  HysteresisInspectorCommonProps,
  "activeSnapshot" | "draft" | "kernel" | "points" | "stageId" | "targetMetadata"
>) {
  const policy = parseJsonRecord(draft?.storagePolicy);
  const savedPoints = points.filter((point) => point.snapshot_id);
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
      title="Snapshots"
      badge={`${savedPoints.length} saved`}
    >
      <FieldRow
        label="Magnetization policy"
        value={String(policy?.magnetization ?? "average only")}
      />
      {policy?.every_n != null && (
        <FieldRow label="Every N" value={String(policy.every_n)} />
      )}
      {policy?.key_event_threshold_dm != null && (
        <FieldRow
          label="Key-event threshold"
          value={String(policy.key_event_threshold_dm)}
        />
      )}
      <FieldRow label="Calculated points" value={String(points.length)} />
      <FieldRow label="Saved snapshots" value={String(savedPoints.length)} />
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
      {savedPoints.length > 0 ? (
        <div className="fm-hysteresis-inspector-table-wrap">
          <table className="fm-hysteresis-inspector-table">
            <thead>
              <tr>
                <th>Point</th>
                <th>Field (mT)</th>
                <th>Snapshot</th>
                <th>Status</th>
                <th>Source</th>
                <th>Detail</th>
                <th className="fm-hysteresis-inspector-table__actions-heading">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {savedPoints.map((point) => (
                <HysteresisSnapshotRow
                  key={`${point.point_id}:${point.snapshot_id}`}
                  active={activeSnapshot?.snapshotId === point.snapshot_id}
                  onLoadPointIn3D={loadPointIn3D}
                  onUsePointAsInitialState={usePointAsInitialState}
                  point={point}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="fm-hysteresis-inspector-empty">
          No magnetization snapshots have been saved for this hysteresis stage.
        </div>
      )}
    </InspectorGroup>
  );
}

function HysteresisSnapshotRow({
  active,
  onLoadPointIn3D,
  onUsePointAsInitialState,
  point,
}: {
  active: boolean;
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
  return (
    <tr data-active={active ? "true" : undefined} data-status={point.status}>
      <td>{point.point_id}</td>
      <td>{point.field_value_mT.toFixed(2)}</td>
      <td>{point.snapshot_id}</td>
      <td>{point.snapshot_storage_status ?? "available"}</td>
      <td>{snapshotSourceLabel(point)}</td>
      <td>{point.snapshot_storage_reason ?? "ready"}</td>
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
      </td>
    </tr>
  );
}

function snapshotSourceLabel(point: HysteresisPointSchema): string {
  if (point.snapshot_zarr_store_ref) {
    return point.snapshot_zarr_store_ref;
  }
  if (point.snapshot_json_artifact_ref) {
    return "JSON fallback";
  }
  return point.snapshot_storage_format ?? "n/a";
}
