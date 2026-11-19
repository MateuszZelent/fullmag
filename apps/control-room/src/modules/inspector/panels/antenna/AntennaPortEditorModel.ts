import type { AuthoringTransactionRequest, AuthoringTransactionResponse, SceneResource } from "@/kernel/api/apiTypes";
import { antennaPortValidationMessages, type AntennaPortModeResource } from "@/shared/domain/physics/antennaPortValidation";

export interface AntennaPortBranchDraft {
  /** Local form identity must not change when the authored branch ID is edited. */
  rowKey: string;
  originalId: string | null;
  id: string;
  inletTerminalRef: string;
  outletTerminalRef: string;
  signedWeight: string;
}

export interface AntennaPortDraft {
  key: string;
  baseRevision: number;
  dirty: boolean;
  currentTransportId: string;
  branches: AntennaPortBranchDraft[];
}

export function createAntennaPortDraft(mode: AntennaPortModeResource, key: string, revision: number): AntennaPortDraft {
  return {
    key, baseRevision: revision, dirty: false, currentTransportId: mode.current_transport_id,
    branches: mode.branches.map((branch, index) => ({
      rowKey: `original-${index}`, originalId: branch.id, id: branch.id,
      inletTerminalRef: branch.inlet_terminal_ref, outletTerminalRef: branch.outlet_terminal_ref,
      signedWeight: String(branch.signed_weight),
    })),
  };
}

export function antennaPortDraftMatches(mode: AntennaPortModeResource, draft: AntennaPortDraft): boolean {
  return mode.current_transport_id === draft.currentTransportId && mode.branches.length === draft.branches.length &&
    mode.branches.every((branch, index) => {
      const value = draft.branches[index];
      return branch.id === value.id && branch.inlet_terminal_ref === value.inletTerminalRef &&
        branch.outlet_terminal_ref === value.outletTerminalRef && branch.signed_weight === Number(value.signedWeight);
    });
}

export function buildAntennaPortTransaction(
  scene: SceneResource, objectId: string, portId: string, draft: AntennaPortDraft,
): AuthoringTransactionRequest {
  if (!Number.isSafeInteger(draft.baseRevision) || draft.baseRevision < 0 || scene.revision !== draft.baseRevision) {
    throw new Error("Scene changed. Refresh and explicitly rebase port edits.");
  }
  const objects = scene.objects?.filter((object) => object.id === objectId) ?? [];
  if (objects.length !== 1 || objects[0].locked) throw new Error("Current unlocked source object is required.");
  const ports = scene.antenna_port_modes ?? [];
  const matches = ports.filter((port) => port.id === portId);
  if (matches.length !== 1 || matches[0].source_object_id !== objectId) {
    throw new Error("Port mode is missing, ambiguous or does not belong to this source object.");
  }
  const port = matches[0];
  const branches = draft.branches.map((branch) => {
    const originals = branch.originalId === null ? [] : port.branches.filter((item) => item.id === branch.originalId);
    if (branch.originalId !== null && originals.length !== 1) {
      throw new Error(`Original branch '${branch.originalId}' changed or is ambiguous. Revert and edit the current port.`);
    }
    // Do not turn an empty numeric input into zero or normalize authored weights.
    if (!branch.signedWeight.trim() || !Number.isFinite(Number(branch.signedWeight))) {
      throw new Error(`Branch '${branch.id}' signed weight must be a finite explicit number.`);
    }
    return {
      ...originals[0], id: branch.id, inlet_terminal_ref: branch.inletTerminalRef,
      outlet_terminal_ref: branch.outletTerminalRef, signed_weight: Number(branch.signedWeight),
    };
  });
  const candidate = { ...port, current_transport_id: draft.currentTransportId, branches };
  const candidatePorts = ports.map((item) => item.id === portId ? candidate : item);
  const messages = antennaPortValidationMessages(candidate, { ...scene, antenna_port_modes: candidatePorts });
  if (messages.length) throw new Error(messages.join("; "));
  return { kind: "merge_patch", base_revision: draft.baseRevision, merge_patch: { antenna_port_modes: candidatePorts } };
}

/** Rebind editable rows to the IDs actually acknowledged, including renamed/new branches. */
export function acknowledgeAntennaPortDraft(
  current: AntennaPortDraft | null, submitted: AntennaPortDraft, revision: number,
): AntennaPortDraft | null {
  if (!Number.isSafeInteger(revision) || revision <= submitted.baseRevision) throw new Error("Invalid port ACK revision.");
  if (current?.key !== submitted.key || current.baseRevision !== submitted.baseRevision) return current;
  return {
    ...current, baseRevision: revision, dirty: current !== submitted,
    branches: current.branches.map((branch) => {
      const acknowledged = submitted.branches.find((item) => item.rowKey === branch.rowKey);
      return acknowledged ? { ...branch, originalId: acknowledged.id } : branch;
    }),
  };
}

/** Reject a malformed ACK before either history or the canonical cache is published. */
export function committedAntennaPortScene(
  response: AuthoringTransactionResponse, submitted: AntennaPortDraft, objectId: string, portId: string,
  expectedSceneId: string, expectedPort: AntennaPortModeResource,
): SceneResource {
  acknowledgeAntennaPortDraft(submitted, submitted, response.scene_revision);
  const scene = response.committed_scene;
  const matches = scene?.antenna_port_modes?.filter((mode) => mode.id === portId) ?? [];
  const mode = matches[0];
  if (!expectedSceneId.trim() || !scene || scene.scene?.id !== expectedSceneId || scene.revision !== response.scene_revision ||
      (scene.scene_revision !== undefined && scene.scene_revision !== response.scene_revision) || matches.length !== 1 ||
      mode.source_object_id !== objectId || mode.schema_version !== expectedPort.schema_version ||
      mode.normalization_current_a !== expectedPort.normalization_current_a ||
      mode.normalization?.kind !== expectedPort.normalization?.kind ||
      mode.normalization?.source_cut_ref !== expectedPort.normalization?.source_cut_ref ||
      mode.normalization?.orientation !== expectedPort.normalization?.orientation || !antennaPortDraftMatches(mode, submitted) ||
      antennaPortValidationMessages(mode, scene).length > 0) {
    throw new Error("Port ACK omitted or changed the submitted scene. Refresh and explicitly rebase or revert before applying again.");
  }
  return scene;
}
