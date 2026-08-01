"use client";

import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorGroup } from "../../../primitives/InspectorGroup";
import type { HysteresisInspectorCommonProps } from "./HysteresisInspectorTypes";

export function HysteresisCurrentFieldInspector({
  progress,
}: Pick<HysteresisInspectorCommonProps, "progress">) {
  return (
    <InspectorGroup
      title="Current Field"
      badge={
        progress?.current_field_mT != null
          ? `${progress.current_field_mT.toFixed(2)} mT`
          : "waiting"
      }
    >
      <FieldRow
        label="Field"
        value={
          progress?.current_field_mT != null
            ? progress.current_field_mT.toFixed(3)
            : "n/a"
        }
        unit={progress?.current_field_mT != null ? "mT" : undefined}
      />
      <FieldRow
        label="Point"
        value={
          progress?.active_point_index != null && progress.total_points != null
            ? `${progress.active_point_index + 1} / ${progress.total_points}`
            : "n/a"
        }
      />
      <FieldRow
        label="Algorithm"
        value={
          [progress?.current_settle_step_kind, progress?.current_settle_step_method]
            .filter(Boolean)
            .join(" ") || "n/a"
        }
      />
      <FieldRow
        label="Status"
        value={progress?.status ?? (progress?.active ? "running" : "not started")}
      />
    </InspectorGroup>
  );
}
