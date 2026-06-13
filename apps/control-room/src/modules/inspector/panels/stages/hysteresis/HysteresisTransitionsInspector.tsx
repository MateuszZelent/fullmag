"use client";

import { useCallback, useMemo } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { Button } from "@/shared/ui/Button";

import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorSection } from "../../../primitives/InspectorSection";
import { hysteresisInitialStateActionPresentation } from "./HysteresisInspectorUtils";
import type { HysteresisInspectorCommonProps } from "./HysteresisInspectorTypes";

export function HysteresisTransitionsInspector({
  activePoint,
  kernel,
  points,
  progress,
  stageId,
}: Pick<
  HysteresisInspectorCommonProps,
  "activePoint" | "kernel" | "points" | "progress" | "stageId"
>) {
  const commandContext = useMemo(
    () => createCommandContext("inspector", kernel),
    [kernel],
  );
  const selectedPoint =
    activePoint?.pointId != null
      ? points.find((point) => point.point_id === activePoint.pointId) ?? null
      : null;
  const initialStateAction = hysteresisInitialStateActionPresentation(
    selectedPoint?.snapshot_id ?? activePoint?.snapshotId ?? null,
    selectedPoint?.snapshot_storage_status,
    selectedPoint?.snapshot_storage_reason,
  );

  const usePointAsInitialState = useCallback(() => {
    if (!stageId || !selectedPoint?.snapshot_id) return;
    kernel.commands.execute("hysteresis.use-point-as-initial-state", commandContext, {
      stageId,
      snapshotId: selectedPoint.snapshot_id,
      snapshotArtifactRef: selectedPoint.snapshot_json_artifact_ref ?? null,
      snapshotResourceRef: selectedPoint.snapshot_resource_ref ?? null,
    });
  }, [commandContext, kernel, selectedPoint, stageId]);

  return (
    <InspectorSection
      value="hysteresis-transitions"
      title="Transitions"
      badge={progress?.status === "completed" ? "available" : "after completion"}
    >
      <FieldRow label="Stage status" value={progress?.status ?? "not started"} />
      <FieldRow
        label="Calculated points"
        value={
          progress?.completed_points != null && progress.total_points != null
            ? `${progress.completed_points} / ${progress.total_points}`
            : String(points.length)
        }
      />
      <FieldRow
        label="Selected point"
        value={
          selectedPoint
            ? `${selectedPoint.point_id} at ${selectedPoint.field_value_mT.toFixed(3)} mT`
            : "none"
        }
      />
      <div className="fm-hysteresis-inspector-actions">
        <Button
          size="sm"
          variant="secondary"
          disabled={initialStateAction.disabled}
          onClick={usePointAsInitialState}
          title={initialStateAction.title}
        >
          Use selected point as initial
        </Button>
      </div>
      {!selectedPoint && (
        <div className="fm-hysteresis-inspector-empty">
          Select a saved hysteresis point or snapshot before using a previous
          field state as the next initial magnetization.
        </div>
      )}
    </InspectorSection>
  );
}
