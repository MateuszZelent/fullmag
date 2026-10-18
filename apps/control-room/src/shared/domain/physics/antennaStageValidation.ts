import type { SceneResource } from "@/kernel/api/apiTypes";
import { antennaPortValidationMessages } from "./antennaPortValidation";

type AntennaSolveStage = NonNullable<SceneResource["antenna_field_solve_stages"]>[number];

function hasCurrentViewContract(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const view = value as Record<string, unknown>;
  return Array.isArray(view.stable_vertex_ids)
    && view.stable_vertex_ids.length > 0
    && Array.isArray(view.boundary_faces)
    && view.boundary_faces.length > 0
    && Boolean(view.identity && typeof view.identity === "object")
    && Boolean(view.pins && typeof view.pins === "object")
    && Boolean(view.closure && typeof view.closure === "object");
}

function hasClosedCircuitContract(value: unknown): boolean {
  const record = (entry: unknown): Record<string, unknown> | null => entry !== null
    && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : null;
  const transport = record(value);
  const authored = record(transport?.structured_current_closure);
  const prepared = record(transport?.conservative_current_source);
  return authored?.kind === "closed_geometry" && authored.schema_version === "structured_current_closure.v2"
    || prepared?.kind === "closed_geometry_potential_jump" && prepared.schema_version === "conservative_current_source.v2";
}

export function antennaStageValidationMessages(
  stage: AntennaSolveStage,
  scene: SceneResource | null,
): string[] {
  const messages: string[] = [];
  if (!stage.target_refs?.length) {
    messages.push("field solve requires at least one explicitly authored target");
  }
  if (scene) {
    const transport = (scene.current_transports ?? []).find(
      (candidate) => candidate.name === stage.current_transport_id,
    );
    if (!transport) {
      messages.push(`missing current transport '${stage.current_transport_id}'`);
    } else if (transport.structured_current_closure != null && transport.conservative_current_source != null) {
      messages.push("current transport cannot combine structured_current_closure with conservative_current_source; choose one explicit source");
    } else if (transport.external_lead_preparation || (transport.conservative_current_source && !hasClosedCircuitContract(transport))) {
      messages.push("external-electrode source is inspection-only; a qualified complete circuit is required for H_ant_basis, FFT and LLG");
    } else if (!hasCurrentViewContract(transport.conservative_current_view) && !hasClosedCircuitContract(transport)) {
      messages.push(`current transport '${stage.current_transport_id}' requires a mesh-exact ConservativeCurrentView before field solve`);
    }
  }
  if (scene) {
    const portModesById = new Map(
      (scene.antenna_port_modes ?? []).map((candidate) => [candidate.id, candidate]),
    );
    for (const portId of stage.port_mode_ids) {
      const port = portModesById.get(portId);
      if (!port) {
        messages.push(`missing port mode '${portId}'`);
        continue;
      }
      if (
        port.source_object_id !== stage.source_object_id ||
        port.current_transport_id !== stage.current_transport_id
      ) {
        messages.push(`port mode '${portId}' is bound to a different source or transport`);
      } else {
        messages.push(...antennaPortValidationMessages(port, scene)
          .map((message) => `port '${portId}': ${message}`));
      }
    }
  }
  if (stage.port_mode_ids.length !== 1) {
    messages.push("field solve requires exactly one independently normalized port mode");
  }
  if (stage.outputs.filter((output) => output.quantity === "H_ant_basis").length !== 1) {
    messages.push("stage must publish exactly one H_ant_basis output");
  }
  return messages;
}

/** Authored input readiness only; actual mesh/materialization and runtime gates remain authoritative. */
export function antennaInspectionValidationMessages(stage: AntennaSolveStage, scene: SceneResource | null): string[] {
  if (!scene) return ["Current scene is required for inspection preparation."];
  const transport = scene.current_transports?.find((item) => item.name === stage.current_transport_id);
  if (!transport) return [`missing current transport '${stage.current_transport_id}'`];
  if (hasClosedCircuitContract(transport)) {
    const messages: string[] = [];
    if (!stage.target_refs?.length) messages.push("Inspection requires explicitly authored field-sampling targets.");
    if (transport.structured_current_closure != null && transport.conservative_current_source != null) {
      messages.push("current transport cannot combine structured_current_closure with conservative_current_source; choose one explicit source");
    }
    if (transport.external_lead_preparation || transport.conservative_current_view || stage.conservative_current_view_ref
        || (transport.boundaries != null && (!Array.isArray(transport.boundaries) || transport.boundaries.length > 0))) {
      messages.push("Closed-circuit inspection conflicts with legacy electrodes or current-view bindings; resolve these explicit inputs before execution.");
    }
    const ports = (scene.antenna_port_modes ?? []).filter((port) => stage.port_mode_ids.includes(port.id));
    if (stage.port_mode_ids.length !== 1 || ports.length !== 1 || ports[0].schema_version !== "antenna_port_mode.v3"
        || ports[0].source_object_id !== stage.source_object_id || ports[0].current_transport_id !== stage.current_transport_id) {
      messages.push("Closed-circuit inspection requires one v3 source-cut port bound to this source and transport.");
    } else {
      messages.push(...antennaPortValidationMessages(ports[0], scene));
    }
    messages.push("NOT VERIFIED: closed-circuit materialization, source-cut continuity, geometry freshness and field sampling must pass execution validation.");
    return messages;
  }
  if (!transport.external_lead_preparation && !transport.conservative_current_source) return ["Author external actuators and lead preparation before raw inspection."];
  if ((transport.boundaries != null && (!Array.isArray(transport.boundaries) || transport.boundaries.length > 0)) || transport.conservative_current_view || transport.structured_current_closure || stage.conservative_current_view_ref) return ["Inspection source conflicts with legacy boundaries/view/closure; apply explicit preparation."];
  const messages: string[] = [];
  if (!stage.target_refs?.length) messages.push("Inspection requires explicitly authored field-sampling targets.");
  if (stage.port_mode_ids.length !== 1 || !scene.antenna_port_modes?.some((port) => port.id === stage.port_mode_ids[0] && port.source_object_id === stage.source_object_id && port.current_transport_id === stage.current_transport_id)) messages.push("Inspection requires one port bound to this source and transport.");
  messages.push("NOT VERIFIED: actual cap bindings, geometry freshness, component balance and sampling must pass execution materialization.");
  return messages;
}
