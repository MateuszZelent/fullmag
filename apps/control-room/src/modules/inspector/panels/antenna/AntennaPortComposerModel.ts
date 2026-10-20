import type { AuthoringTransactionRequest, SceneResource } from "@/kernel/api/apiTypes";
import { antennaPortValidationMessages, type AntennaPortModeResource } from "@/shared/domain/physics/antennaPortValidation";
import type { AntennaPortBranchDraft } from "./AntennaPortEditorModel";

export interface AntennaNewPortDraft {
  key: string;
  baseRevision: number;
  dirty: boolean;
  id: string;
  transport: string;
  branches: AntennaPortBranchDraft[];
}

export function emptyAntennaPortBranch(rowKey: string): AntennaPortBranchDraft {
  return { rowKey, originalId: null, id: "", inletTerminalRef: "", outletTerminalRef: "", signedWeight: "" };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function antennaPortCreationTransports(scene: SceneResource | null, objectId: string): { name: string; definition: Record<string, unknown> }[] {
  const currents = scene?.current_transports ?? [];
  return currents.flatMap(current => {
    const name = current.name, domain = current.domain;
    if (typeof name !== "string" || !name.trim() || currents.filter(item => item.name === name).length !== 1 ||
        current.kind !== "current_transport" || current.model !== "ohmic_poisson" ||
        (current.coupling !== undefined && current.coupling !== "one_way") || current.time_envelope != null ||
        !Array.isArray(domain) || !domain.some(region => record(region)?.object_id === objectId)) return [];
    return [{ name, definition: current }];
  });
}

/** A second port must not silently create a new source, drive, cut, mesh or solve. */
export function composeAntennaPort(scene: SceneResource, objectId: string, draft: AntennaNewPortDraft): AntennaPortModeResource {
  const owners = (scene.objects ?? []).filter(object => object.id === objectId);
  if (owners.length !== 1 || owners[0].locked || !["antenna", "conductor"].includes(owners[0].role ?? "")) {
    throw new Error("One unlocked authored antenna or conductor is required.");
  }
  if (!draft.id.trim() || draft.id !== draft.id.trim() || draft.id.includes("\0")) throw new Error("Author a non-empty port ID without surrounding whitespace.");
  const existingIds = (scene.antenna_port_modes ?? []).map(port => port.id);
  if (existingIds.some(id => !id.trim()) || new Set(existingIds).size !== existingIds.length) throw new Error("Existing port inventory contains ambiguous identities. Resolve them before appending a port.");
  if ((scene.antenna_port_modes ?? []).some(port => port.id === draft.id)) throw new Error("Port ID already exists. Choose a unique ID explicitly.");
  const transports = antennaPortCreationTransports(scene, objectId).filter(transport => transport.name === draft.transport);
  if (transports.length !== 1) throw new Error("Select one existing static one-way Ohmic transport containing this source.");
  const transport = transports[0].definition;
  const source = record(transport.conservative_current_source);
  if (transport.structured_current_closure != null || source?.kind === "closed_geometry_potential_jump") {
    throw new Error("Closed-loop sources require their explicit v3 port and source cut; another port cannot be appended to the same source transport. Configure a separate source explicitly.");
  }
  const branches = draft.branches.map(branch => {
    if (!branch.signedWeight.trim() || !Number.isFinite(Number(branch.signedWeight))) throw new Error("Every signed branch weight must be a finite explicit number.");
    return { id: branch.id, inlet_terminal_ref: branch.inletTerminalRef, outlet_terminal_ref: branch.outletTerminalRef, signed_weight: Number(branch.signedWeight) };
  });
  const port: AntennaPortModeResource = { schema_version: "antenna_port_mode.v2", id: draft.id, source_object_id: objectId,
    current_transport_id: draft.transport, normalization_current_a: 1, branches };
  const candidate = { ...scene, antenna_port_modes: [...(scene.antenna_port_modes ?? []), port] };
  const errors = antennaPortValidationMessages(port, candidate);
  if (errors.length) throw new Error(errors.join("; "));
  return port;
}

export function buildAntennaPortCreationTransaction(scene: SceneResource, objectId: string, draft: AntennaNewPortDraft): AuthoringTransactionRequest {
  if (!Number.isSafeInteger(draft.baseRevision) || draft.baseRevision < 0 || draft.baseRevision !== scene.revision) throw new Error("Scene changed. Review and explicitly rebase the new port draft.");
  const port = composeAntennaPort(scene, objectId, draft);
  return { kind: "merge_patch", base_revision: draft.baseRevision, merge_patch: { antenna_port_modes: [...(scene.antenna_port_modes ?? []), port] } };
}
