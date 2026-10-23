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
import { FeedbackBanner } from "../primitives/FeedbackBanner";

export function ObservationFramesOverviewPanel() {
  const frames = useObservationFrameListResource();
  const pinned = useObservationSourceWorkspaceSelector((state) => state.pinned);

  return (
    <div className="fm-inspector-panel" data-inspector-owner="observation-frames-overview">
      <InspectorGroup title="Durable state snapshots">
        <FieldRow label="Resource" value={frames.status} status={frames.status} />
        <FieldRow label="Loaded frames" value={frames.data?.frames.length ?? "—"} />
        {frames.data?.next_cursor ? <p className="fm-help-text" role="status">More snapshots are available beyond this page.</p> : null}
        {frames.error || frames.refreshError ? <FeedbackBanner kind="error" message={(frames.error ?? frames.refreshError)!.message} /> : null}
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
  const descriptor = frame.data;
  const matchesSelection = Boolean(ref && descriptor
    && descriptor.frame_id === ref.frameId
    && descriptor.run_id === ref.runId
    && descriptor.stage_id === ref.stageId
    && descriptor.adapter_id === ref.adapterId
    && descriptor.accepted_state_ref.id.accepted_step === ref.acceptedStep
    && descriptor.accepted_state_ref.id.state_digest === ref.stateDigest
    && descriptor.accepted_state_ref.generation.accepted_revision === ref.acceptedRevision
    && descriptor.accepted_state_ref.generation.runtime_epoch === ref.runtimeEpoch);
  const ready = frame.status === "ready" && !frame.refreshError && matchesSelection;
  const candidate = ready && frame.data && sessionIdentity
    ? pinnedObservationSourceFromFrame(frame.data, sessionIdentity)
    : null;
  const selectedSource = matchesSelection && descriptor && sessionIdentity
    ? pinnedObservationSourceFromFrame(descriptor, sessionIdentity)
    : null;
  const isPinned = selectedSource !== null && pinnedObservationSourceEquals(pinned, selectedSource);

  const pin = useCallback(() => {
    if (candidate) observationSourceWorkspaceStore.pin(candidate);
  }, [candidate]);
  const clear = useCallback(() => observationSourceWorkspaceStore.clear(), []);

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
        {frame.error || frame.refreshError ? (
          <FeedbackBanner kind="error" message={`${(frame.error ?? frame.refreshError)!.message}${descriptor ? " Showing previous details; pinning is unavailable." : ""}`} />
        ) : frame.status === "ready" && !matchesSelection ? (
          <FeedbackBanner kind="error" message="The loaded frame does not match the selected accepted state. Refresh before pinning." />
        ) : frame.status !== "ready" ? (
          <p className="fm-help-text" role="status">{descriptor ? "Refreshing frame. Showing previous details; pinning is unavailable." : "Loading frame details…"}</p>
        ) : null}
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
