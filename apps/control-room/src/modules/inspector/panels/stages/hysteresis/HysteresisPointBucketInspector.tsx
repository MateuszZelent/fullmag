"use client";

import { useCallback, useMemo } from "react";

import type { HysteresisPointSchema } from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";
import {
  hysteresisPointTargetMetadata,
  hysteresisPointVectorResourceRef,
} from "@/shared/domain/study/HysteresisChart";

import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorSection } from "../../../primitives/InspectorSection";
import type { HysteresisInspectorCommonProps } from "./HysteresisInspectorTypes";
import { HysteresisPointTable } from "./HysteresisPointTable";

export type HysteresisPointBucket = "completed" | "queued" | "planned";

export function HysteresisPointBucketInspector({
  bucket,
  kernel,
  points,
  progress,
  stageId,
  targetMetadata,
}: Pick<
  HysteresisInspectorCommonProps,
  "kernel" | "points" | "progress" | "stageId" | "targetMetadata"
> & {
  bucket: HysteresisPointBucket;
}) {
  const commandContext = useMemo(
    () => createCommandContext("inspector", kernel),
    [kernel],
  );
  const completedCount = progress?.completed_points ?? points.length;
  const totalCount = progress?.total_points ?? null;
  const queuedCount =
    progress?.queued_points ?? (totalCount != null ? Math.max(0, totalCount - completedCount) : null);
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
  const runPointCommand = useCallback(
    (
      commandId:
        | "hysteresis.bookmark-point"
        | "hysteresis.compare-point"
        | "hysteresis.export-point-csv",
      point: HysteresisPointSchema,
    ) => {
      if (!stageId) return;
      kernel.commands.execute(commandId, commandContext, {
        point,
        stageId,
      });
    },
    [commandContext, kernel, stageId],
  );

  return (
    <InspectorSection
      value={`hysteresis-points-${bucket}`}
      title={pointBucketTitle(bucket)}
      badge={pointBucketBadge(bucket, points.length, queuedCount, totalCount)}
    >
      <FieldRow label="Calculated points" value={String(points.length)} />
      <FieldRow label="Completed points" value={String(completedCount)} />
      {queuedCount != null && <FieldRow label="Queued points" value={String(queuedCount)} />}
      {totalCount != null && <FieldRow label="Total planned" value={String(totalCount)} />}
      {bucket === "completed" ? (
        points.length > 0 ? (
          <HysteresisPointTable
            onBookmarkPoint={(point) =>
              runPointCommand("hysteresis.bookmark-point", point)
            }
            onComparePoint={(point) =>
              runPointCommand("hysteresis.compare-point", point)
            }
            onExportPoint={(point) =>
              runPointCommand("hysteresis.export-point-csv", point)
            }
            onLoadPointIn3D={loadPointIn3D}
            onUsePointAsInitialState={usePointAsInitialState}
            points={points}
          />
        ) : (
          <div className="fm-hysteresis-inspector-empty">
            No completed point records are available yet.
          </div>
        )
      ) : (
        <div className="fm-hysteresis-inspector-empty">
          {bucket === "queued"
            ? queuedPointMessage(queuedCount)
            : plannedPointMessage(totalCount, completedCount)}
        </div>
      )}
    </InspectorSection>
  );
}

function pointBucketTitle(bucket: HysteresisPointBucket): string {
  if (bucket === "completed") return "Completed Points";
  if (bucket === "queued") return "Queued Points";
  return "Planned Points";
}

function pointBucketBadge(
  bucket: HysteresisPointBucket,
  completedRecords: number,
  queuedCount: number | null,
  totalCount: number | null,
): string {
  if (bucket === "completed") return `${completedRecords} completed`;
  if (bucket === "queued") return queuedCount != null ? `${queuedCount} queued` : "queued";
  return totalCount != null ? `${totalCount} planned` : "planned";
}

function queuedPointMessage(queuedCount: number | null): string {
  if (queuedCount == null) {
    return "Queued point count is not available for this run yet.";
  }
  if (queuedCount === 0) {
    return "No queued points remain for this hysteresis stage.";
  }
  return `${queuedCount} field point${queuedCount === 1 ? "" : "s"} remain queued. Detailed point records will appear after each field step is completed.`;
}

function plannedPointMessage(totalCount: number | null, completedCount: number): string {
  if (totalCount == null) {
    return "The planned point count is not available yet.";
  }
  return `${totalCount} field point${totalCount === 1 ? "" : "s"} are planned; ${completedCount} have completed.`;
}
