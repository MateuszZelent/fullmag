import type { AuthoringTransactionRequest, JsonObject, SceneResource } from "@/kernel/api/apiTypes";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
const text = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());
export interface ConductorConductivityRow { key: string; label: string; partIds: string[]; value: string }
export interface ConductorMaterialDraft { key: string; baseRevision: number; rows: ConductorConductivityRow[]; dirty: boolean }

/** Edit the existing geometry/charge contract together; never rebuild a source descriptor. */
export function conductorMaterialContext(scene: SceneResource, objectId: string) {
  const objects = (scene.objects ?? []).filter(object => object.id === objectId);
  if (objects.length !== 1 || objects[0].locked) throw new Error("A unique unlocked source object is required.");
  const object = objects[0], geometry = record(object.geometry), params = record(geometry?.geometry_params);
  if (!params || !["MicrostripAntennaLayout", "CPWAntennaLayout"].includes(String(geometry?.geometry_kind))) throw new Error("An authored antenna layout is required.");
  const parts = Array.isArray(params.conductors) ? params.conductors.map(record) : [];
  const ids = parts.map(part => part?.id);
  if (!ids.length || ids.some(id => !text(id)) || new Set(ids).size !== ids.length) throw new Error("Explicit unique conductor part IDs are required.");
  const rows: ConductorConductivityRow[] = [{ key: "conductivity_s_per_m", label: "Layout conductor conductivity", partIds: ids as string[], value: String(params.conductivity_s_per_m ?? "") }];
  const loop = record(params.loop), closed = loop?.enabled === true;
  if (closed) for (const end of ["inlet", "outlet"]) {
    const id = loop[`${end}_connection_part_id`];
    if (!text(id) || rows.some(row => row.partIds.includes(id))) throw new Error("Bridge and conductor part IDs must be explicit and distinct.");
    rows.push({ key: `${end}_connection_conductivity_s_per_m`, label: `${end === "inlet" ? "Inlet" : "Outlet"} bridge conductivity`, partIds: [id], value: String(loop[`${end}_connection_conductivity_s_per_m`] ?? "") });
  }
  const currents = scene.current_transports ?? [];
  const matches = currents.filter(current => Array.isArray(current.domain) && current.domain.some(ref => record(ref)?.object_id === objectId));
  const current = matches[0];
  if (matches.length !== 1 || !text(current?.name) || currents.filter(item => item.name === current.name).length !== 1
    || current.kind !== "current_transport" || current.model !== "ohmic_poisson" || current.coupling !== "one_way"
    || current.time_envelope != null || !Array.isArray(current.domain) || current.domain.length !== 1
    || record(current.domain[0])?.object_id !== objectId || record(current.domain[0])?.region_id != null) throw new Error("One static one-way Ohmic transport over this whole object is required.");
  const closure = record(current.structured_current_closure);
  if (current.conservative_current_source != null || current.conservative_current_view != null || current.external_lead_preparation != null
    || closed && (closure?.kind !== "closed_geometry" || closure.schema_version !== "structured_current_closure.v2")
    || !closed && current.structured_current_closure != null) throw new Error("This source requires an explicit material migration. Prepared mesh sources and other source contracts are read-only here.");
  const assignments = Array.isArray(current.materials) ? current.materials.map(record) : [];
  const partIds = rows.flatMap(row => row.partIds);
  const whole = assignments.length === 1 && record(assignments[0]?.region)?.region_id == null;
  if (!assignments.length || assignments.some(assignment => record(assignment?.region)?.object_id !== objectId || !record(assignment?.material))
    || !whole && (assignments.length !== partIds.length || partIds.some(id => assignments.filter(assignment => record(assignment?.region)?.region_id === id).length !== 1))) throw new Error("Charge materials must cover the whole object once or each authored part exactly once, without overlap.");
  return { object, geometry: geometry!, params, loop, current, rows, assignments, whole };
}

export function createConductorMaterialDraft(scene: SceneResource, objectId: string, key: string): ConductorMaterialDraft {
  if (!Number.isSafeInteger(scene.revision) || scene.revision! < 0) throw new Error("A valid scene revision is required.");
  return { key, baseRevision: scene.revision!, rows: conductorMaterialContext(scene, objectId).rows, dirty: false };
}

export function buildConductorMaterialTransaction(scene: SceneResource, objectId: string, draft: ConductorMaterialDraft): AuthoringTransactionRequest {
  if (!Number.isSafeInteger(draft.baseRevision) || draft.baseRevision < 0 || scene.revision !== draft.baseRevision) throw new Error("Scene changed. Revert to the current scene before applying conductivity edits.");
  const context = conductorMaterialContext(scene, objectId);
  if (draft.rows.length !== context.rows.length || context.rows.some((row, index) => row.key !== draft.rows[index].key || JSON.stringify(row.partIds) !== JSON.stringify(draft.rows[index].partIds))) throw new Error("Conductor parts changed. Reload the current material assignments.");
  const values = draft.rows.map(row => {
    if (!row.value.trim() || !Number.isFinite(Number(row.value)) || Number(row.value) <= 0) throw new Error(`${row.label} must be finite and positive in S/m.`);
    return Number(row.value);
  });
  if (context.whole && values.some(value => value !== values[0])) throw new Error("A whole-object material cannot encode different bridge conductivities. Split the charge assignments explicitly before editing separate parts.");
  const loop = context.loop ? { ...context.loop } : null;
  draft.rows.slice(1).forEach((row, index) => { if (loop) loop[row.key] = values[index + 1]; });
  const geometry = { ...context.geometry, geometry_params: { ...context.params, conductivity_s_per_m: values[0], ...(loop ? { loop } : {}) } };
  const materials = context.assignments.map(assignment => {
    const id = record(assignment?.region)?.region_id;
    const index = context.whole ? 0 : draft.rows.findIndex(row => row.partIds.includes(String(id)));
    return { ...assignment, material: { ...record(assignment?.material), sigma_Spm: values[index] } };
  });
  return { kind: "merge_patch", base_revision: draft.baseRevision, merge_patch: {
    objects: (scene.objects ?? []).map(object => object.id === objectId ? { ...object, geometry } : object),
    current_transports: (scene.current_transports ?? []).map(current => current.name === context.current.name ? { ...current, materials } : current),
  } as JsonObject };
}

export function acknowledgeConductorMaterialDraft(current: ConductorMaterialDraft | null, submitted: ConductorMaterialDraft, revision: number): ConductorMaterialDraft | null {
  return current?.key === submitted.key && current.baseRevision === submitted.baseRevision
    ? { ...current, baseRevision: revision, dirty: current !== submitted } : current;
}
