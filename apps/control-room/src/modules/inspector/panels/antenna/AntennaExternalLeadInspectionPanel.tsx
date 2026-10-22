"use client";

import { useState } from "react";

import {
  useAntennaExternalLeadInspectionPayloadResource,
  useAntennaExternalLeadInspectionResource,
} from "@/kernel/resources/antennaResources";
import { useStageExecutionResource } from "@/kernel/resources/studyRuntimeResources";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  decodeInspectionPreview,
  resolveInspectionPreviewState,
  inspectionPreviewCount,
  inspectionSelectionMatchesContext,
  resolveInspectionRuntimeStage,
  type InspectionRuntimeSelection,
} from "./AntennaExternalLeadInspectionModel";

function executionValue(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unrecorded";
  const record = value as Record<string, unknown>;
  return ["backend", "discretization", "device", "precision", "execution_mode"]
    .filter((key) => typeof record[key] === "string")
    .map((key) => `${key}=${record[key]}`).join(" · ") || "unrecorded";
}

function vectorValue(vector: [number, number, number]): string {
  return `(${vector.map((value) => value.toExponential(3)).join(", ")})`;
}

export function AntennaExternalLeadInspectionPanel({ authoredStageId }: { authoredStageId: string }) {
  const identity = useSessionResourceIdentity();
  const execution = useStageExecutionResource();
  const [selection, setSelection] = useState<InspectionRuntimeSelection | null>(null);
  // Reset only this local view preference before committing a changed context.
  // Keeping an out-of-scope choice would resurrect it after a run/session ABA.
  if (selection && !inspectionSelectionMatchesContext(selection, authoredStageId, execution.data, identity)) {
    setSelection(null);
  }
  const mapping = resolveInspectionRuntimeStage(authoredStageId, execution.data, identity, selection);
  const executionCurrent = execution.status === "ready" && !execution.refreshError;
  const inspection = useAntennaExternalLeadInspectionResource(
    mapping.state === "mapped" ? mapping.runtimeStageId : null,
    { pauseLoad: !executionCurrent },
  );
  const preview = resolveInspectionPreviewState({ authoredStageId, identity, execution, inspection, mapping });
  const { viewRecord, current, count, closed } = preview;
  let { state, message } = preview;
  const range = count > 0 ? `bytes=0-${count * 3 * 8 - 1}` : undefined;
  const payloadOwner = state === "inspection_only" ? current : null;
  const positions = useAntennaExternalLeadInspectionPayloadResource(payloadOwner, closed ? "sample_xyz" : "sample_positions", { range });
  const field = useAntennaExternalLeadInspectionPayloadResource(payloadOwner, closed ? "h_raw" : "magnetic_field", { range });
  let samples: ReturnType<typeof decodeInspectionPreview> | null = null;
  const payloadError = positions.error ?? positions.refreshError ?? field.error ?? field.refreshError;
  if (payloadError) {
    state = "error";
    message = payloadError.message;
  } else if (payloadOwner && positions.status === "ready" && field.status === "ready" && positions.data && field.data) {
    try {
      samples = decodeInspectionPreview(positions.data, field.data, count, closed?.payloads.sample_xyz.byte_length ?? payloadOwner.manifest!.sample_positions.byte_count);
    } catch (error) {
      state = "error";
      message = error instanceof Error ? error.message : String(error);
    }
  }
  const manifest = viewRecord?.manifest;
  let previewCount = count;
  if (state === "loading" && viewRecord?.status === "inspection_only") {
    try { previewCount = inspectionPreviewCount(viewRecord); } catch { /* No invalid stale preview. */ }
  }
  return (
    <div className="fm-antenna-inspection" data-testid="antenna-external-lead-inspection" data-state={state}>
      <InspectorGroup title="Antenna field inspection" badge={state} collapsible>
        <FeedbackBanner kind="warning" message="NOT VERIFIED · inspection only. Raw H for the recorded drive, not H/I. The exact field scope is shown below. This is not a qualified field basis, LLG drive or spin-wave/FFT result. Current-scene freshness is not certified." />
        <FieldRow label="Antenna solve definition" value={authoredStageId} mono />
        <Select
          value={mapping.state === "mapped" ? mapping.runtimeStageId : ""}
          disabled={mapping.candidates.length === 0}
          onValueChange={(runtimeStageId) => {
            if (identity && execution.data && mapping.candidates.some((candidate) => candidate.runtimeStageId === runtimeStageId)) {
              setSelection({ authoredStageId, runtimeStageId, runId: execution.data.run_id, identity });
            }
          }}
        >
          <SelectTrigger aria-label="Inspection execution" data-testid="antenna-inspection-execution-select" className="fm-antenna-inspection__execution-select">
            <SelectValue placeholder="Select an execution" />
          </SelectTrigger>
          <SelectContent className="fm-antenna-inspection__execution-options">
            {mapping.candidates.map((candidate) => (
              <SelectItem key={candidate.runtimeStageId} value={candidate.runtimeStageId}>
                {candidate.runtimeStageId} · {candidate.status}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldRow label="Runtime stage" value={mapping.state === "mapped" ? mapping.runtimeStageId : "not selected"} mono />
        {viewRecord ? (
          <>
            <FieldRow label="Status" value={viewRecord.status} />
            <FieldRow label="Qualification" value={viewRecord.qualification} />
            <FieldRow label="Field scope" value={viewRecord.field_scope} />
            <FieldRow label="Run" value={viewRecord.run_id} mono />
            <FieldRow label="Port" value={viewRecord.port_mode_id} mono />
            <FieldRow label="Output" value={viewRecord.output_id} mono />
            <FieldRow label="Stage revision" value={String(viewRecord.stage_revision)} />
            <FieldRow label="Record digest" value={viewRecord.record_content_digest} mono />
            {viewRecord.diagnostic && viewRecord.status === "inspection_only" ? <FieldRow label="Diagnostic" value={viewRecord.diagnostic} /> : null}
          </>
        ) : null}
        {manifest ? (
          <>
            <FieldRow label="Validation scope" value={manifest.validation_scope} />
            <FieldRow label="Content digest" value={manifest.content_digest} mono />
            <FieldRow label="Requested execution" value={executionValue(manifest.requested_execution)} />
            <FieldRow label="Resolved execution" value={executionValue(manifest.resolved_execution)} />
            <FieldRow label="Drive" value={manifest.drive_id} mono />
            <FieldRow label="Carrier" value={`${manifest.sampling_carrier.carrier_kind} · ${manifest.sampling_carrier.location}`} />
            <FieldRow label="Sampling domain" value={JSON.stringify(manifest.sampling_carrier.domain)} mono />
            <FieldRow label="Sampling topology" value={manifest.sampling_carrier.topology_digest} mono />
            {(["bundle", "sample_positions", "magnetic_field", "device_vertex_ids", "device_potential"] as const).map((kind) => (
              <FieldRow key={kind} label={kind} value={`${manifest[kind].value_count} values · ${manifest[kind].byte_count} bytes · ${manifest[kind].scalar_type} · ${manifest[kind].layout}`} unit={manifest[kind].unit} />
            ))}
          </>
        ) : null}
        {closed ? <>
          <FieldRow label="Validation scope" value={closed.validation_scope} />
          <FieldRow label="Content digest" value={closed.content_digest} mono />
          <FieldRow label="Source object" value={closed.source_object_id} mono />
          <FieldRow label="Current transport" value={closed.current_transport_id} mono />
          <FieldRow label="Requested execution" value={executionValue(closed.requested_intent.requested_execution)} />
          <FieldRow label="Resolved execution" value={executionValue(closed.resolved_execution)} />
          <FieldRow label="H carrier" value={`${closed.sample_carrier.carrier_kind} · ${closed.sample_carrier.location} · ${closed.sample_carrier.domain.kind}`} />
          <FieldRow label="Carrier counts" value={`${closed.vertex_count} V nodes · ${closed.cell_count} J cells · ${closed.target_count} H samples / ${closed.sample_cell_count} sampling cells`} />
          <FieldRow label="Signed cut current" value={closed.source.source_current_a.toExponential(6)} unit="A" />
          <FieldRow label="Per-A scale" value={closed.scale_per_a.toExponential(6)} unit="1/A" />
          {(["prepared_execution_digest", "accepted_charge_field_digest", "accepted_source_state_digest", "current_balance_certificate_digest"] as const).map((key) => <FieldRow key={key} label={key} value={closed.source[key]} mono />)}
          {Object.entries(closed.payloads).map(([kind, descriptor]) => <FieldRow key={kind} label={kind} value={`${descriptor.byte_length} bytes · ${descriptor.layout}`} unit={descriptor.unit} />)}
        </> : null}
        <p className="fm-antenna-inspection__status" role={state === "loading" || state === "unavailable" || !message ? "status" : "alert"}>
          {message ?? "Recorded inspection metadata; no native or physics qualification."}
        </p>
        {previewCount > 0 && (state === "inspection_only" || state === "loading") ? (
          <div data-testid="antenna-inspection-sample-preview" data-preview-state={samples ? "ready" : "loading"}>
            <FieldRow label="Preview samples" value={`${previewCount} of ${closed?.target_count ?? manifest?.sampling_carrier.sample_count ?? 0}`} />
            <p className="fm-antenna-inspection__status" role="status">{samples ? "Digest-pinned raw samples (not qualified)." : "Awaiting current digest-pinned samples…"}</p>
            {Array.from({ length: previewCount }, (_, index) => (
              <div key={index} className="fm-antenna-field-preview__sample">
                <FieldRow label={`Sample ${index + 1} position`} value={samples ? vectorValue(samples[index].positionM) : "Awaiting current payload"} unit="m" />
                <FieldRow label={`Sample ${index + 1} H`} value={samples ? vectorValue(samples[index].fieldApm) : "Awaiting current payload"} unit="A/m" />
              </div>
            ))}
          </div>
        ) : null}
      </InspectorGroup>
    </div>
  );
}
