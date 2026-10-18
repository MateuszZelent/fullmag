import type { AuthoringTransactionRequest, JsonObject, SceneResource } from "@/kernel/api/apiTypes";
import { antennaPortValidationMessages } from "@/shared/domain/physics/antennaPortValidation";
import { antennaSolveTargetKey, antennaSolveTargetOptions } from "./AntennaSolveTargetsEditorModel";
import { composeAntennaSpectrumRequest, type AntennaSpectrumDraft } from "./AntennaSpectrumComposerModel";

export type AntennaResourceTransaction = Extract<AuthoringTransactionRequest, { kind: "merge_patch" }>;
export type AntennaEditableKind = "port" | "projection" | "spectrum";
export const antennaCollection = { port: "antenna_port_modes", projection: "antenna_target_projections", spectrum: "antenna_spectrum_requests" } as const;
type Port = NonNullable<SceneResource["antenna_port_modes"]>[number];
type Projection = NonNullable<SceneResource["antenna_target_projections"]>[number];
type Spectrum = NonNullable<SceneResource["antenna_spectrum_requests"]>[number];
export type AntennaEditableResource = Port | Projection | Spectrum;
export interface AntennaResourceDraft {
  key: string;
  baseRevision: number;
  values: Record<string, string>;
  branches: Array<{ id: string; inlet: string; outlet: string; weight: string }>;
}

export function antennaEditableResource(scene: SceneResource | null, kind: AntennaEditableKind, id: string): AntennaEditableResource | undefined {
  return scene?.[antennaCollection[kind]]?.find((item) => item.id === id);
}
export function createAntennaResourceDraft(scene: SceneResource, kind: AntennaEditableKind, id: string, key: string): AntennaResourceDraft {
  const resource = antennaEditableResource(scene, kind, id);
  if (!resource || typeof scene.revision !== "number") throw new Error("Current resource and scene revision are required.");
  const draft: AntennaResourceDraft = { key, baseRevision: scene.revision, values: {}, branches: [] };
  if (kind === "port") {
    const port = resource as Port;
    draft.branches = port.branches.map((branch) => ({ id: branch.id, inlet: branch.inlet_terminal_ref, outlet: branch.outlet_terminal_ref, weight: String(branch.signed_weight) }));
  } else if (kind === "projection") {
    const projection = resource as Projection;
    draft.values = { target: antennaSolveTargetKey(projection.target), rebind: "" };
  } else {
    const request = resource as Spectrum;
    const plane = request.sampling_plane;
    draft.values = {
      target: antennaSolveTargetKey(request.target), rebind: "", originM: plane.origin_m.join(", "),
      axisU: plane.axis_u.join(", "), axisV: plane.axis_v.join(", "), extentUM: String(plane.extent_u_m), extentVM: String(plane.extent_v_m),
      samplesU: String(plane.sample_count_u), samplesV: String(plane.sample_count_v), windowKind: request.window,
      normalization: request.normalization, component: request.component, outsidePolicy: plane.outside_policy,
    };
  }
  return draft;
}
export function antennaResourceDependents(scene: SceneResource, kind: AntennaEditableKind, id: string): string[] {
  if (kind === "projection") return (scene.solved_antenna_drives ?? []).filter((item) => item.projection_ref === id).map((item) => `drive:${item.id}`);
  if (kind === "spectrum") return [];
  return [
    ...(scene.antenna_field_solve_stages ?? []).filter((item) => item.port_mode_ids.includes(id)).map((item) => `field solve:${item.id}`),
    ...(scene.solved_antenna_drives ?? []).filter((item) => item.port_mode_id === id).map((item) => `drive:${item.id}`),
    ...(scene.antenna_spectrum_requests ?? []).filter((item) => item.port_mode_id === id).map((item) => `spectrum:${item.id}`),
    ...(scene.current_transports ?? []).flatMap((transport) => {
      const preparation = transport.external_lead_preparation as { drives?: Array<{ id: string; port_mode_ref: string }> } | null | undefined;
      return (preparation?.drives ?? []).filter((drive) => drive.port_mode_ref === id).map((drive) => `terminal drive:${transport.name}/${drive.id}`);
    }),
  ];
}

export function buildAntennaResourceTransaction(scene: SceneResource, kind: AntennaEditableKind, id: string, draft: AntennaResourceDraft, remove = false): AntennaResourceTransaction {
  if (!Number.isSafeInteger(draft.baseRevision) || draft.baseRevision < 0 || scene.revision !== draft.baseRevision) throw new Error("Scene changed. Refresh and explicitly rebase the draft.");
  const resource = antennaEditableResource(scene, kind, id);
  if (!resource) throw new Error("Selected antenna resource is missing.");
  const sourceId = kind === "port" ? (resource as Port).source_object_id : scene.antenna_field_solve_stages?.find((stage) => stage.id === (kind === "projection" ? (resource as Projection).solution.stage_id : (resource as Spectrum).solution_ref.stage_id))?.source_object_id;
  if (!sourceId || !scene.objects?.some((object) => object.id === sourceId && !object.locked)) throw new Error("An existing unlocked source object is required.");
  const collection = antennaCollection[kind];
  if (remove) {
    const dependents = antennaResourceDependents(scene, kind, id);
    if (dependents.length) throw new Error(`Removal refused. Rebind or remove these dependents first: ${dependents.join(", ")}.`);
    return { kind: "merge_patch", base_revision: draft.baseRevision, merge_patch: { [collection]: (scene[collection] ?? []).filter((item) => item.id !== id) } as unknown as JsonObject };
  }
  let next: AntennaEditableResource;
  if (kind === "port") {
    const port = resource as Port;
    next = { ...port, branches: draft.branches.map((branch) => {
      if (!branch.weight.trim()) throw new Error("Every signed branch weight must be authored explicitly.");
      return { id: branch.id.trim(), inlet_terminal_ref: branch.inlet.trim(), outlet_terminal_ref: branch.outlet.trim(), signed_weight: Number(branch.weight) };
    }) };
    const errors = antennaPortValidationMessages(next, scene);
    if (errors.length) throw new Error(errors.join("; "));
    // Terminal preparation owns observations separately; never silently rename its bound terminals.
    if ((scene.current_transports ?? []).some((transport) => transport.name === port.current_transport_id && transport.external_lead_preparation) && JSON.stringify((next as Port).branches.map((branch) => [branch.id, branch.inlet_terminal_ref, branch.outlet_terminal_ref])) !== JSON.stringify(port.branches.map((branch) => [branch.id, branch.inlet_terminal_ref, branch.outlet_terminal_ref]))) throw new Error("Terminal preparation exists. Edit its observation bindings before changing branch identities or terminal references.");
  } else {
    const target = antennaSolveTargetOptions(scene).find((option) => option.key === draft.values.target)?.target;
    if (!target) throw new Error("Select an existing explicit target.");
    const oldSolution = kind === "projection" ? (resource as Projection).solution : (resource as Spectrum).solution_ref;
    let solution = oldSolution;
    let reboundPort: string | undefined;
    if (draft.values.rebind) {
      const stage = scene.antenna_field_solve_stages?.find((item) => item.id === draft.values.rebind);
      const outputs = stage?.outputs.filter((output) => output.quantity === "H_ant_basis") ?? [];
      if (!stage || outputs.length !== 1 || stage.port_mode_ids.length !== 1) throw new Error("Rebind requires one H_ant_basis output and one explicit port mode.");
      if (!scene.antenna_port_modes?.some((port) => port.id === stage.port_mode_ids[0] && port.source_object_id === stage.source_object_id && port.current_transport_id === stage.current_transport_id)) throw new Error("Rebind stage has no matching port.");
      if (scene.objects?.find((object) => object.id === stage.source_object_id)?.locked) throw new Error("Rebind source object is locked.");
      reboundPort = stage.port_mode_ids[0];
      solution = { kind: "stage_output", stage_id: stage.id, output_id: outputs[0].id };
    }
    if (kind === "projection") {
      if (reboundPort && scene.solved_antenna_drives?.some((drive) => drive.projection_ref === id && drive.port_mode_id !== reboundPort)) throw new Error("Rebind refused: dependent drive port differs. Rebind or remove the drive first.");
      next = { ...(resource as Projection), target, solution };
    } else {
      const request = resource as Spectrum;
      if (request.transform !== "spatial_fft" || request.nonuniform_k_grid || request.equilibrium_ref || request.mode_basis_ref) throw new Error("This editor supports source spatial FFT only. Nonuniform and modal requests remain unchanged.");
      if (target.kind !== "object") throw new Error("Structured source FFT editor requires an object target.");
      if (!["rectangular", "hann", "hamming", "blackman"].includes(draft.values.windowKind) || !["integral_si", "unitary_discrete"].includes(draft.values.normalization) || !["x", "y", "z", "u", "v", "normal", "vector_power"].includes(draft.values.component) || !["error", "zero"].includes(draft.values.outsidePolicy)) throw new Error("Unsupported structured FFT option.");
      const parsed = composeAntennaSpectrumRequest(scene, solution.stage_id, { ...draft.values, targetObjectId: target.object_id } as unknown as AntennaSpectrumDraft);
      if (solution.output_id !== parsed.solution_ref.output_id || (request.port_mode_id && !reboundPort && request.port_mode_id !== parsed.port_mode_id)) throw new Error("Spectrum source must match the selected solve output and port.");
      next = { ...request, target, solution_ref: solution, port_mode_id: reboundPort ?? request.port_mode_id, sampling_plane: { ...parsed.sampling_plane, interpolation: request.sampling_plane.interpolation }, window: parsed.window, normalization: parsed.normalization, component: parsed.component };
    }
  }
  return { kind: "merge_patch", base_revision: draft.baseRevision, merge_patch: { [collection]: (scene[collection] ?? []).map((item) => item.id === id ? next : item) } as unknown as JsonObject };
}
export function acknowledgeAntennaResourceDraft(current: AntennaResourceDraft | null, submitted: AntennaResourceDraft, revision: number): AntennaResourceDraft | null {
  if (!Number.isSafeInteger(revision) || revision <= submitted.baseRevision) throw new Error("Invalid antenna resource ACK revision.");
  if (current?.key !== submitted.key || current.baseRevision !== submitted.baseRevision) return current;
  return current === submitted ? null : { ...current, baseRevision: revision };
}
