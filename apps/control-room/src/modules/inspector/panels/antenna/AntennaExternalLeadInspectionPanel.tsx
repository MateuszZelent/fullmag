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
  inspectionMatchesRuntimeStage,
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
  const viewRecord = inspection.data &&
    inspectionMatchesRuntimeStage(inspection.data, authoredStageId, mapping, identity)
    ? inspection.data : null;
  const current = executionCurrent && inspection.status === "ready" && !inspection.refreshError
    ? viewRecord : null;
  let state: string = "unavailable";
  let message: string | null = null;
  let count = 0;
  if (execution.error || execution.refreshError || inspection.error || inspection.refreshError) {
    state = "error";
    message = (execution.error ?? execution.refreshError ?? inspection.error ?? inspection.refreshError)?.message ?? "Inspection unavailable.";
  } else if (!identity || !executionCurrent) {
    state = "loading";
    message = "Waiting for confirmed stage execution…";
  } else if (mapping.state !== "mapped") {
    state = mapping.state;
    message = mapping.message;
  } else if (inspection.status === "loading" || inspection.status === "stale" || inspection.status === "idle") {
    state = "loading";
    message = "Loading the exact runtime stage inspection…";
  } else if (!inspection.data) {
    message = "This runtime stage has no external-lead inspection record.";
  } else if (!current) {
    state = "identity_mismatch";
    message = "Inspection identity does not match this antenna definition, run and session incarnation.";
  } else if (current.qualification !== "NOT VERIFIED" || current.field_scope !== "external_electrode_truncation") {
    state = "error";
    message = "Inspection has an unsupported qualification or field scope.";
  } else if (current.status === "failed" || current.status === "cancelled") {
    state = current.status;
    message = current.diagnostic ?? `Inspection ${current.status}; no numerical payload is available.`;
  } else {
    try {
      count = inspectionPreviewCount(current);
      state = "inspection_only";
    } catch (error) {
      state = "error";
      message = error instanceof Error ? error.message : String(error);
    }
  }
  const range = count > 0 ? `bytes=0-${count * 3 * 8 - 1}` : undefined;
  const payloadOwner = state === "inspection_only" ? current : null;
  const positions = useAntennaExternalLeadInspectionPayloadResource(payloadOwner, "sample_positions", { range });
  const field = useAntennaExternalLeadInspectionPayloadResource(payloadOwner, "magnetic_field", { range });
  let samples: ReturnType<typeof decodeInspectionPreview> | null = null;
  const payloadError = positions.error ?? positions.refreshError ?? field.error ?? field.refreshError;
  if (payloadError) {
    state = "error";
    message = payloadError.message;
  } else if (payloadOwner && positions.status === "ready" && field.status === "ready" && positions.data && field.data) {
    try {
      samples = decodeInspectionPreview(positions.data, field.data, count, payloadOwner.manifest!.sample_positions.byte_count);
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
      <InspectorGroup title="External-lead inspection" badge={state} collapsible>
        <FeedbackBanner kind="warning" message="NOT VERIFIED · external_electrode_truncation. Raw H for the recorded drive, not H/I. This is not a qualified field basis, LLG drive or spin-wave/FFT result. Current-scene freshness is not certified." />
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
        <p className="fm-antenna-inspection__status" role={state === "loading" || state === "unavailable" || !message ? "status" : "alert"}>
          {message ?? "Recorded inspection metadata; no native or physics qualification."}
        </p>
        {previewCount > 0 && (state === "inspection_only" || state === "loading") ? (
          <div data-testid="antenna-inspection-sample-preview" data-preview-state={samples ? "ready" : "loading"}>
            <FieldRow label="Preview samples" value={`${previewCount} of ${manifest?.sampling_carrier.sample_count ?? 0}`} />
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
