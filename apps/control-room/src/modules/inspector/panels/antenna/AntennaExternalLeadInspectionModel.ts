import type {
  AntennaExternalLeadInspectionResource,
  BinaryResourceResult,
  StageExecutionResource,
} from "@/kernel/api/apiTypes";
import {
  sessionResourceIdentitiesEqual,
  type SessionResourceIdentity,
} from "@/kernel/resources/sessionResourceIdentity";

export const MAX_INSPECTION_PREVIEW_SAMPLES = 8;

export interface InspectionRuntimeSelection {
  authoredStageId: string;
  runtimeStageId: string;
  runId: string;
  identity: SessionResourceIdentity;
}

export interface InspectionExecutionCandidate {
  runtimeStageId: string;
  status: string;
}

export type InspectionRuntimeMapping = (
  | { state: "unavailable" | "identity_mismatch" | "ambiguous"; message: string }
  | { state: "mapped"; runtimeStageId: string; runId: string }
) & { candidates: InspectionExecutionCandidate[] };

export function inspectionSelectionMatchesContext(
  selection: InspectionRuntimeSelection,
  authoredStageId: string,
  execution: StageExecutionResource | null,
  identity: SessionResourceIdentity | null,
): boolean {
  return typeof execution?.run_id === "string" && Boolean(execution.run_id.trim()) && selection.authoredStageId === authoredStageId &&
    selection.runId === execution?.run_id && sessionResourceIdentitiesEqual(selection.identity, identity) &&
    sessionResourceIdentitiesEqual(identity, execution ? {
      sessionId: execution.session_id,
      sessionEpoch: execution.session_epoch,
      requestScopeEpoch: execution.request_scope_epoch,
    } : null);
}

export function resolveInspectionRuntimeStage(
  authoredStageId: string,
  execution: StageExecutionResource | null,
  identity: SessionResourceIdentity | null,
  selection: InspectionRuntimeSelection | null = null,
): InspectionRuntimeMapping {
  if (!execution || !identity) {
    return { state: "unavailable", message: "No confirmed stage execution is available.", candidates: [] };
  }
  if (!sessionResourceIdentitiesEqual(identity, {
    sessionId: execution.session_id,
    sessionEpoch: execution.session_epoch,
    requestScopeEpoch: execution.request_scope_epoch,
  }) || typeof execution.run_id !== "string" || !execution.run_id.trim()) {
    return { state: "identity_mismatch", message: "Stage execution belongs to a different session incarnation.", candidates: [] };
  }
  const matches = execution.stages.filter((stage) =>
    stage.antenna_solve_stage_id === authoredStageId,
  );
  if (matches.length === 0) {
    return { state: "unavailable", message: "No execution explicitly references this antenna solve definition.", candidates: [] };
  }
  if (matches.some((stage) => !stage.stage_id?.trim()) ||
      new Set(matches.map((stage) => stage.stage_id)).size !== matches.length) {
    return { state: "identity_mismatch", message: "Execution IDs are missing or non-unique; no inspection can be selected safely.", candidates: [] };
  }
  const candidates = matches.map((stage) => ({ runtimeStageId: stage.stage_id, status: stage.status }));
  const scopedSelection = selection && inspectionSelectionMatchesContext(selection, authoredStageId, execution, identity)
    ? selection : null;
  if (scopedSelection) {
    if (!matches.some((stage) => stage.stage_id === scopedSelection.runtimeStageId)) {
      return { state: "unavailable", message: "The selected execution is no longer in this run. Select another execution explicitly.", candidates };
    }
    return { state: "mapped", runtimeStageId: scopedSelection.runtimeStageId, runId: execution.run_id, candidates };
  }
  if (matches.length !== 1) {
    return { state: "ambiguous", message: "Multiple executions reference this definition. Select an execution; no result is selected automatically.", candidates };
  }
  return { state: "mapped", runtimeStageId: matches[0].stage_id, runId: execution.run_id, candidates };
}

export function inspectionMatchesRuntimeStage(
  inspection: AntennaExternalLeadInspectionResource,
  authoredStageId: string,
  mapping: InspectionRuntimeMapping,
  identity: SessionResourceIdentity | null,
): boolean {
  return mapping.state === "mapped" &&
    sessionResourceIdentitiesEqual(identity, {
      sessionId: inspection.session_id,
      sessionEpoch: inspection.session_epoch,
      requestScopeEpoch: inspection.request_scope_epoch,
    }) && inspection.run_id === mapping.runId &&
    inspection.runtime_stage_id === mapping.runtimeStageId &&
    inspection.stage_id === authoredStageId;
}

export function inspectionPreviewCount(inspection: AntennaExternalLeadInspectionResource): number {
  const manifest = inspection.manifest;
  if (inspection.status !== "inspection_only" || inspection.qualification !== "NOT VERIFIED" ||
      inspection.field_scope !== "external_electrode_truncation" || !manifest ||
      manifest.validation_scope !== "manifest_only" || inspection.outputs.length !== 1 ||
      inspection.outputs[0].inspection_ref.stage_id !== inspection.stage_id ||
      inspection.outputs[0].inspection_ref.output_id !== inspection.output_id ||
      inspection.outputs[0].inspection_ref.content_digest !== manifest.content_digest) {
    throw new Error("Inspection metadata is incompatible with the unqualified preview contract.");
  }
  const sampleCount = manifest.sampling_carrier.sample_count;
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > 1_000_000) {
    throw new Error("Inspection sample count is outside its supported bound.");
  }
  for (const [descriptor, unit] of [
    [manifest.sample_positions, "m"], [manifest.magnetic_field, "A/m"],
  ] as const) {
    if (descriptor.scalar_type !== "float64_le" || descriptor.layout !== "sample_xyz_interleaved" ||
        descriptor.unit !== unit || descriptor.value_count !== sampleCount * 3 ||
        descriptor.byte_count !== sampleCount * 3 * 8) {
      throw new Error("Inspection position and H carriers have incompatible units, layout or length.");
    }
  }
  return Math.min(MAX_INSPECTION_PREVIEW_SAMPLES, sampleCount);
}

export function decodeInspectionPreview(
  positions: BinaryResourceResult<ArrayBuffer>,
  field: BinaryResourceResult<ArrayBuffer>,
  sampleCount: number,
  totalBytes: number,
): { positionM: [number, number, number]; fieldApm: [number, number, number] }[] {
  const expectedBytes = sampleCount * 3 * 8;
  if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > MAX_INSPECTION_PREVIEW_SAMPLES ||
      !Number.isSafeInteger(totalBytes) || totalBytes < expectedBytes) {
    throw new Error("Invalid inspection preview byte bound.");
  }
  const views = [positions, field].map((payload) => {
    if (payload.status !== "ready" || !payload.etag || payload.byteLength !== expectedBytes ||
        payload.data.byteLength !== expectedBytes ||
        payload.contentRange !== `bytes 0-${expectedBytes - 1}/${totalBytes}`) {
      throw new Error("Inspection preview response does not match its pinned byte range.");
    }
    return new DataView(payload.data);
  });
  return Array.from({ length: sampleCount }, (_, index) => {
    const vectors = views.map((view) => [0, 1, 2].map((component) =>
      view.getFloat64((index * 3 + component) * 8, true),
    ) as [number, number, number]);
    if (vectors.flat().some((value) => !Number.isFinite(value))) {
      throw new Error(`Inspection sample ${index + 1} contains a non-finite value.`);
    }
    return { positionM: vectors[0], fieldApm: vectors[1] };
  });
}
