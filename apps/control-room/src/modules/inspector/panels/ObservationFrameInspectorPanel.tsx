"use client";

import { useCallback } from "react";

import { useObservationFrameListResource, useObservationFrameResource } from "@/kernel/resources/observationFrameResources";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import {
  observationSourceWorkspaceStore,
  pinnedObservationSourceEquals,
  pinnedObservationSourceFromFrame,
} from "@/kernel/workspace/observationSourceWorkspace";
import { useObservationSourceWorkspaceSelector } from "@/kernel/workspace/useObservationSourceWorkspace";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorGroup } from "../primitives/InspectorGroup";

export function ObservationFramesOverviewPanel() {
  const frames = useObservationFrameListResource();
  const pinned = useObservationSourceWorkspaceSelector((state) => state.pinned);

  return (
    <div className="fm-inspector-panel" data-inspector-owner="observation-frames-overview">
      <InspectorGroup title="Durable state snapshots">
        <FieldRow label="Resource" value={frames.status} status={frames.status} />
        <FieldRow label="Frames" value={frames.data?.frames.length ?? "—"} />
        <FieldRow label="Pinned source" value={pinned?.frameId ?? "None"} mono />
        <p className="m-0 text-fm-help leading-relaxed text-fm-muted">
          Select a complete frame to inspect its immutable accepted-state identity
          and pin it as the historical source for analytical views.
        </p>
      </InspectorGroup>
    </div>
  );
}

export function ObservationFrameInspectorPanel({ selection }: InspectorPanelProps) {
  const ref = selection.ref?.type === "observation-frame" ? selection.ref : null;
  const frame = useObservationFrameResource(ref?.frameId, { enabled: ref !== null });
  const sessionIdentity = useSessionResourceIdentity();
  const pinned = useObservationSourceWorkspaceSelector((state) => state.pinned);
  const candidate = frame.data && sessionIdentity
    ? pinnedObservationSourceFromFrame(frame.data, sessionIdentity)
    : null;
  const isPinned = candidate !== null && pinnedObservationSourceEquals(pinned, candidate);

  const pin = useCallback(() => {
    if (candidate) observationSourceWorkspaceStore.pin(candidate);
  }, [candidate]);
  const clear = useCallback(() => observationSourceWorkspaceStore.clear(), []);
  const descriptor = frame.data;

  return (
    <div className="fm-inspector-panel" data-inspector-owner="observation-frame">
      <InspectorGroup title="Observation frame">
        <FieldRow label="Frame" value={ref?.frameId ?? "Unavailable"} mono />
        <FieldRow label="Run" value={ref?.runId ?? "Unavailable"} mono />
        <FieldRow label="Stage" value={ref?.stageId ?? "Unavailable"} mono />
        <FieldRow label="Accepted step" value={ref?.acceptedStep ?? "—"} />
        <FieldRow label="Accepted revision" value={ref?.acceptedRevision ?? "—"} />
        <FieldRow label="Runtime epoch" value={ref?.runtimeEpoch ?? "—"} />
        <FieldRow label="Adapter" value={ref?.adapterId ?? "Unavailable"} mono />
        <FieldRow label="State digest" value={ref?.stateDigest ?? "Unavailable"} mono />
      </InspectorGroup>
      <InspectorGroup title="Published data">
        <FieldRow label="Status" value={frame.status} status={frame.status} />
        <FieldRow
          label="Grid cells"
          value={descriptor ? descriptor.grid_cells.join(" × ") : "—"}
        />
        <FieldRow
          label="Quantities"
          value={descriptor?.quantity_ids.join(", ") || "—"}
        />
        <FieldRow label="State codec" value={
          descriptor
            ? `${descriptor.state_codec_id} ${descriptor.state_codec_version}`
            : "—"
        } />
        <div className="flex flex-wrap gap-2 pt-1" role="group" aria-label="Observation source actions">
          <Button
            disabled={!candidate || isPinned}
            onClick={pin}
            size="sm"
            type="button"
            variant="primary"
          >
            {isPinned ? "Source pinned" : "Pin source"}
          </Button>
          {isPinned ? (
            <Button onClick={clear} size="sm" type="button" variant="secondary">
              Unpin
            </Button>
          ) : null}
        </div>
      </InspectorGroup>
    </div>
  );
}
