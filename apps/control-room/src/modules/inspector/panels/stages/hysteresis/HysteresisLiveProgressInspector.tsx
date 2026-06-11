"use client";

import { useCallback, useMemo } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { HysteresisChart, clearHysteresisPointSelectionForLive } from "@/shared/domain/study/HysteresisChart";
import { Button } from "@/shared/ui/Button";

import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorSection } from "../../../primitives/InspectorSection";
import type { HysteresisInspectorCommonProps } from "./HysteresisInspectorTypes";

export function HysteresisLiveProgressInspector({
  activeSnapshot,
  kernel,
  points,
  progress,
  stageId,
}: Pick<
  HysteresisInspectorCommonProps,
  "activeSnapshot" | "kernel" | "points" | "progress" | "stageId"
>) {
  const commandContext = useMemo(
    () => createCommandContext("inspector", kernel),
    [kernel],
  );
  const handleReturnToLive = useCallback(() => {
    if (stageId) {
      clearHysteresisPointSelectionForLive(kernel, stageId, "inspector");
    }
    kernel.commands.execute("hysteresis.return-to-live", commandContext, {
      stageId: stageId ?? null,
    });
  }, [commandContext, kernel, stageId]);

  return (
    <InspectorSection
      value="hysteresis-live-progress"
      title="Live Progress"
      badge={
        progress?.active
          ? progress.current_field_mT != null
            ? `${progress.current_field_mT.toFixed(2)} mT`
            : "running"
          : points.length > 0
            ? `${points.length} points`
            : "waiting"
      }
    >
      {activeSnapshot && (
        <div className="fm-hysteresis-inspector-live-snapshot">
          <FieldRow label="3D state" value={`Snapshot ${activeSnapshot.snapshotId}`} />
          {activeSnapshot.pointId != null && (
            <FieldRow
              label="Loaded point"
              value={
                activeSnapshot.fieldValueMt != null
                  ? `${activeSnapshot.pointId} at ${activeSnapshot.fieldValueMt.toFixed(3)} mT`
                  : String(activeSnapshot.pointId)
              }
            />
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={handleReturnToLive}
            title="Return the 3D viewport to the live magnetization field"
          >
            Return to live
          </Button>
        </div>
      )}
      {progress && (
        <>
          <FieldRow
            label="Current field"
            value={
              progress.current_field_mT != null
                ? progress.current_field_mT.toFixed(3)
                : "n/a"
            }
            unit={progress.current_field_mT != null ? "mT" : undefined}
          />
          <FieldRow
            label="Point progress"
            value={
              progress.active_point_index != null && progress.total_points != null
                ? `${progress.active_point_index + 1} / ${progress.total_points}`
                : progress.current_point_index != null && progress.total_points != null
                  ? `${progress.current_point_index + 1} / ${progress.total_points}`
                  : "preparing"
            }
          />
          <FieldRow
            label="Active algorithm"
            value={
              [progress.current_settle_step_kind, progress.current_settle_step_method]
                .filter(Boolean)
                .join(" ") || "n/a"
            }
          />
        </>
      )}
      {stageId ? (
        <HysteresisChart commandSource="inspector" kernel={kernel} stageId={stageId} />
      ) : (
        <div className="fm-hysteresis-inspector-empty">Stage id is unavailable.</div>
      )}
    </InspectorSection>
  );
}
