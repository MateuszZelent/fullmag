import type { AntennaExternalLeadInspectionResource, AntennaInspectionDisplayResource } from "../api/apiTypes";

export const CLOSED_LOOP_PAYLOAD_KINDS = ["stable_vertex_ids", "vertex_xyz", "sample_xyz", "sample_cells", "conductivity", "v_raw", "v_per_a", "j_center_raw", "j_center_per_a", "j_local_raw", "j_local_per_a", "h_raw", "h_per_a", "cells", "faces", "weak", "prepared_preimage", "charge_preimage", "source_preimage", "certificate", "authoring_receipt", "direct_evidence"] as const;
export type ClosedLoopPayloadKind = typeof CLOSED_LOOP_PAYLOAD_KINDS[number];
export interface ClosedLoopPayloadDescriptor { path: string; sha256: string; byte_length: number; layout: string; unit: string }
export interface ClosedLoopInspectionManifest {
  schema_version: "antenna_field_solution.v2"; status: "inspection_only"; validation_scope: "full_cold_bundle";
  qualification: "NOT VERIFIED"; field_scope: "full_closed_loop.inspection_only.v2";
  content_digest: string; source_object_id: string; current_transport_id: string; stage_id: string; port_mode_id: string; solution_id: string;
  requested_intent: Record<string, unknown>; resolved_execution: Record<string, unknown>;
  source: Record<string, unknown> & { source_current_a: number; source_absolute_flux_a: number; prepared_execution_digest: string; accepted_charge_field_digest: string; accepted_source_state_digest: string; current_balance_certificate_digest: string };
  sample_carrier: { domain: { kind: string }; carrier_kind: string; location: string; topology_digest: string };
  vertex_count: number; cell_count: number; target_count: number; sample_cell_count: number; face_count: number; weak_reaction_count: number;
  signed_normalization_a: number; scale_per_a: number; payloads: Record<ClosedLoopPayloadKind, ClosedLoopPayloadDescriptor>;
}
export type AntennaInspectionResource = AntennaExternalLeadInspectionResource & { closed_loop_manifest?: unknown };
export interface ClosedLoopInspectionDisplay {
  schema_version: "antenna_inspection_display.closed_loop.v2";
  resource_id: string; session_id: string; session_epoch: string; request_scope_epoch: string; run_id: string; runtime_stage_id: string;
  stage_revision: number; record_content_digest: string; content_digest: string;
  normalization: "raw_authored_potential_jump"; closed_loop_display: unknown;
  capabilities: { display: boolean; current_density: boolean; per_ampere_basis: boolean; source_fft: boolean; llg_drive: boolean };
}
export type AntennaInspectionDisplay = AntennaInspectionDisplayResource | ClosedLoopInspectionDisplay;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const digest = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const pin = (value: unknown) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
const id = (value: unknown) => typeof value === "string" && value.trim().length > 0 && value.length <= 4096 && !value.includes("\0");
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 1_048_576;
const thin = (value: unknown): boolean => !Array.isArray(value) && (!object(value) || Object.values(value).every(thin));

/** Runtime boundary for the additive API family, until managed OpenAPI regeneration. No legacy manifest is synthesized. */
export function parseClosedLoopManifest(value: unknown): ClosedLoopInspectionManifest {
  if (!object(value) || value.schema_version !== "antenna_field_solution.v2" || value.status !== "inspection_only" ||
      value.validation_scope !== "full_cold_bundle" || value.qualification !== "NOT VERIFIED" || value.field_scope !== "full_closed_loop.inspection_only.v2" ||
      !pin(value.content_digest) || !["source_object_id", "current_transport_id", "stage_id", "port_mode_id", "solution_id"].every((key) => id(value[key])) ||
      !["vertex_count", "cell_count", "target_count", "sample_cell_count", "face_count", "weak_reaction_count"].every((key) => count(value[key])) ||
      !object(value.requested_intent) || !thin(value.requested_intent) || !object(value.resolved_execution) || !thin(value.resolved_execution) ||
      new TextEncoder().encode(JSON.stringify(value)).byteLength > 64 * 1024 ||
      !object(value.source) || !object(value.sample_carrier) || !object(value.sample_carrier.domain) || !id(value.sample_carrier.domain.kind) ||
      !id(value.sample_carrier.carrier_kind) || !id(value.sample_carrier.location) || !pin(value.sample_carrier.topology_digest) || !object(value.payloads)) {
    throw new Error("Closed-loop inspection metadata violates its thin unqualified family contract.");
  }
  const source = value.source;
  if (!["prepared_execution_digest", "accepted_charge_field_digest", "accepted_source_state_digest", "current_balance_certificate_digest", "view_identity_digest"].every((key) => digest(source[key])) ||
      typeof source.source_current_a !== "number" || typeof source.source_absolute_flux_a !== "number" ||
      !Number.isFinite(source.source_current_a) || !Number.isFinite(source.source_absolute_flux_a) || source.source_absolute_flux_a < 0 ||
      !(Math.abs(source.source_current_a) > 100 * (1e-18 + 1e-10 * source.source_absolute_flux_a)) ||
      value.signed_normalization_a !== source.source_current_a || value.scale_per_a !== 1 / source.source_current_a || !Number.isFinite(value.scale_per_a)) {
    throw new Error("Closed-loop signed normalization or accepted source identities are invalid.");
  }
  if (!["potential_jump_v", "measured_potential_jump_v", "gauge_mean_v", "charge_relative_residual", "max_paired_weak_flux_mismatch_a"].every((key) => typeof source[key] === "number" && Number.isFinite(source[key])) ||
      Number(source.charge_relative_residual) < 0 || Number(source.charge_relative_residual) > 1e-12 || Number(source.max_paired_weak_flux_mismatch_a) < 0 ||
      !object(source.terminal_observation_currents) || Object.values(source.terminal_observation_currents).some((current) => typeof current !== "number" || !Number.isFinite(current))) throw new Error("Closed-loop residual or observation-current metadata is invalid.");
  const payloads = value.payloads, paths = new Set<string>();
  if (Object.keys(payloads).length !== CLOSED_LOOP_PAYLOAD_KINDS.length) throw new Error("Closed-loop payload closure is incomplete.");
  for (const kind of CLOSED_LOOP_PAYLOAD_KINDS) {
    const descriptor = payloads[kind];
    if (!object(descriptor) || descriptor.path !== `antenna/field_solutions/${value.solution_id}/${kind}.bin` ||
        typeof value.solution_id !== "string" || !/^[A-Za-z0-9_.-]{1,255}$/.test(value.solution_id) || value.solution_id.includes("..") ||
        !digest(descriptor.sha256) || !Number.isSafeInteger(descriptor.byte_length) || Number(descriptor.byte_length) <= 0 || Number(descriptor.byte_length) > 512 * 1024 * 1024 ||
        !id(descriptor.layout) || !id(descriptor.unit) || paths.has(String(descriptor.path))) throw new Error("Closed-loop payload descriptor/path is invalid or aliased.");
    paths.add(String(descriptor.path));
  }
  const shapes = [
    ["stable_vertex_ids", "node_u64_le", "1", Number(value.vertex_count) * 8], ["vertex_xyz", "node_xyz_f64_le", "m", Number(value.vertex_count) * 24],
    ["sample_xyz", "sample_xyz_f64_le", "m", Number(value.target_count) * 24], ["sample_cells", "sample_tet4_u32_le", "1", Number(value.sample_cell_count) * 16], ["conductivity", "cell_f64_le", "S/m", Number(value.cell_count) * 8],
    ["v_raw", "node_f64_le", "V", Number(value.vertex_count) * 8], ["v_per_a", "node_f64_le", "V/A", Number(value.vertex_count) * 8],
    ["j_center_raw", "cell_xyz_f64_le", "A/m^2", Number(value.cell_count) * 24], ["j_center_per_a", "cell_xyz_f64_le", "1/m^2", Number(value.cell_count) * 24],
    ["j_local_raw", "cell_local4_xyz_f64_le", "A/m^2", Number(value.cell_count) * 96], ["j_local_per_a", "cell_local4_xyz_f64_le", "1/m^2", Number(value.cell_count) * 96],
    ["h_raw", "sample_xyz_f64_le", "A/m", Number(value.target_count) * 24], ["h_per_a", "sample_xyz_f64_le", "1/m", Number(value.target_count) * 24],
    ["cells", "closed_loop_cell280_le", "SI", Number(value.cell_count) * 280],
    ["faces", "face_u64x3_f64_le", "A", Number(value.face_count) * 32], ["weak", "paired_u64x2_f64x2_le", "A", Number(value.weak_reaction_count) * 32],
    ["prepared_preimage", "canonical_named_fields_be_bits.v2", "1", 0], ["charge_preimage", "canonical_named_fields_be_bits.v2", "1", 0], ["source_preimage", "canonical_named_fields_be_bits.v2", "1", 0],
    ["certificate", "canonical_balance_certificate.v1", "1", 0], ["authoring_receipt", "utf8_json_input.v1", "1", 0], ["direct_evidence", "fem_direct_oersted_evidence.v2", "SI", 296 + Number(value.target_count) * 96],
  ] as const;
  for (const [kind, layout, unit, bytes] of shapes) {
    const descriptor = payloads[kind] as Record<string, unknown>;
    if (descriptor.layout !== layout || descriptor.unit !== unit || bytes !== 0 && descriptor.byte_length !== bytes) throw new Error(`Closed-loop ${kind} cardinality, layout or unit mismatch.`);
  }
  return value as unknown as ClosedLoopInspectionManifest;
}
export function closedLoopManifest(inspection: unknown): ClosedLoopInspectionManifest | null {
  if (!object(inspection) || inspection.schema_version !== "antenna_closed_loop_stage_output.v2") return null;
  if (inspection.status !== "inspection_only") return null;
  const manifest = parseClosedLoopManifest(inspection.closed_loop_manifest);
  const outputs = inspection.outputs;
  if (inspection.manifest != null || inspection.qualification !== manifest.qualification || inspection.field_scope !== manifest.field_scope ||
      inspection.source_object_id !== manifest.source_object_id || inspection.stage_id !== manifest.stage_id || inspection.output_id !== manifest.solution_id || inspection.port_mode_id !== manifest.port_mode_id ||
      !Array.isArray(outputs) || outputs.length !== 1 || !object(outputs[0]) || !object(outputs[0].inspection_ref) ||
      outputs[0].content_digest !== manifest.content_digest || stableJson(outputs[0].source) !== stableJson(manifest.source) || outputs[0].inspection_ref.content_digest !== manifest.content_digest || outputs[0].inspection_ref.stage_id !== manifest.stage_id || outputs[0].inspection_ref.output_id !== manifest.solution_id) {
    throw new Error("Closed-loop record and manifest owner differ.");
  }
  return manifest;
}
export function isClosedLoopDisplay(display: AntennaInspectionDisplay): display is ClosedLoopInspectionDisplay {
  return display.schema_version === "antenna_inspection_display.closed_loop.v2";
}
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
export function closedLoopDisplayMatches(inspection: AntennaInspectionResource, display: ClosedLoopInspectionDisplay): boolean {
  try {
    const expected = closedLoopManifest(inspection), actual = parseClosedLoopManifest(display.closed_loop_display);
    return Boolean(expected && stableJson(expected) === stableJson(actual) && display.content_digest === expected.content_digest &&
      display.session_id === inspection.session_id && display.session_epoch === inspection.session_epoch && display.request_scope_epoch === inspection.request_scope_epoch &&
      display.run_id === inspection.run_id && display.runtime_stage_id === inspection.runtime_stage_id && display.stage_revision === inspection.stage_revision &&
      display.record_content_digest === inspection.record_content_digest && display.normalization === "raw_authored_potential_jump" &&
      display.capabilities.display === true && display.capabilities.current_density === true && display.capabilities.per_ampere_basis === false && display.capabilities.source_fft === false && display.capabilities.llg_drive === false);
  } catch { return false; }
}
