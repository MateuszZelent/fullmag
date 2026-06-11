"use client";

import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorSection } from "../../../primitives/InspectorSection";
import { parseJsonRecord } from "./HysteresisInspectorUtils";
import type { HysteresisInspectorCommonProps } from "./HysteresisInspectorTypes";

export function HysteresisSnapshotsInspector({
  draft,
  points,
}: Pick<HysteresisInspectorCommonProps, "draft" | "points">) {
  const policy = parseJsonRecord(draft?.storagePolicy);
  const savedPoints = points.filter((point) => point.snapshot_id).length;
  return (
    <InspectorSection
      value="hysteresis-snapshots"
      title="Snapshots"
      badge={`${savedPoints} saved`}
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
      <FieldRow label="Saved snapshots" value={String(savedPoints)} />
      <div className="fm-hysteresis-inspector-empty">
        Use the Points inspector to load a saved point into the 3D viewport or
        make it the next initial state.
      </div>
    </InspectorSection>
  );
}
