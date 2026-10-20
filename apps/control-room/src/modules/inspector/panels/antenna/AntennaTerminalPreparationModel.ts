import type { AuthoringTransactionRequest, JsonObject, SceneResource } from "@/kernel/api/apiTypes";

export interface AntennaTerminalLeadRow {
  observationId: string;
  conductorId: string;
  selector: "local_u_min" | "local_u_max";
  actuatorId: string;
  lengthM: string;
  conductivitySpm: string;
  layers: string;
  direction: [string, string, string];
  currentA: string;
  loadedBoundaryMarkers?: number[];
}
export interface AntennaTerminalPreparationDraft {
  key: string;
  baseRevision: number;
  geometryBinding: string;
  portId: string;
  revision: string;
  driveId: string;
  dirty: boolean;
  rows: AntennaTerminalLeadRow[];
}
interface Extension extends JsonObject {
  id: string; observation_id: string; object_id: string; boundary_markers: number[];
  length_m: number; conductivity_spm: number; layers: number; outward_direction_xyz: number[];
}
export interface AntennaLeadPreparation extends JsonObject {
  schema_version: "antenna_external_lead_preparation.v1";
  kind: "isolated_branch_straight_stubs";
  revision: string;
  extensions: Extension[];
  drives: { id: string; port_mode_ref: string; outer_terminal_currents_a: Record<string, number> }[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: string, label: string): string {
  if (!value.trim() || value.includes("\0") || new TextEncoder().encode(value).length > 4096) throw new Error(`${label} must be nonempty bounded text.`);
  return value;
}
function number(value: string, label: string): number {
  if (!value.trim() || !Number.isFinite(Number(value))) throw new Error(`Enter a finite ${label}.`);
  return Number(value);
}

export function antennaTerminalGeometryBinding(scene: SceneResource, objectId: string): string {
  const object = scene.objects?.find((item) => item.id === objectId);
  return JSON.stringify([object?.geometry, object?.transform]);
}

/** Exact existing fullmag.antenna-terminal-marker.v1 contract; not a mesh vertex ID. */
export async function antennaTerminalBoundaryMarker(objectId: string, conductorId: string, selector: string): Promise<number> {
  if (selector !== "local_u_min" && selector !== "local_u_max") throw new Error("Unsupported terminal selector.");
  const bytes = new TextEncoder().encode(`fullmag.antenna-terminal-marker.v1\0${objectId}\0${conductorId}\0${selector}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return 1000 + new DataView(digest).getUint32(0, false) % 1_000_000_000;
}

export function createAntennaTerminalPreparationDraft(scene: SceneResource, objectId: string, portId: string, key: string): AntennaTerminalPreparationDraft {
  const port = scene.antenna_port_modes?.find((item) => item.id === portId && item.source_object_id === objectId);
  if (!port) throw new Error("Select an antenna port belonging to this object.");
  const transport = scene.current_transports?.find((item) => item.name === port.current_transport_id);
  if (!transport || transport.conservative_current_source || transport.structured_current_closure) throw new Error("An expert source or structured closure cannot be replaced by this form.");
  const preparation = record(transport.external_lead_preparation);
  if (preparation && (preparation.kind !== "isolated_branch_straight_stubs" || !Array.isArray(preparation.extensions) ||
    !Array.isArray(preparation.drives) || preparation.drives.length !== 1)) throw new Error("This form requires a single-drive straight-stub preparation; other authored controls are preserved.");
  const drive = preparation ? record((preparation.drives as unknown[])[0]) : null;
  if (drive && drive.port_mode_ref !== portId) throw new Error("Existing preparation belongs to a different port.");
  const currents = record(drive?.outer_terminal_currents_a);
  const rows = port.branches.flatMap((branch) => (["local_u_min", "local_u_max"] as const).map((selector) => {
    const observationId = selector === "local_u_min" ? branch.inlet_terminal_ref : branch.outlet_terminal_ref;
    const extension = preparation ? (preparation.extensions as unknown[]).map(record).find((item) => item?.observation_id === observationId) : null;
    if (preparation && !extension) throw new Error(`Existing preparation has no observation ${observationId}; explicit rebinding is required.`);
    const direction = Array.isArray(extension?.outward_direction_xyz) ? extension.outward_direction_xyz.map(String) : ["", "", ""];
    const actuatorId = typeof extension?.id === "string" ? extension.id : `${observationId}:outer`;
    return {
      observationId, conductorId: branch.id, selector, actuatorId,
      lengthM: extension ? String(extension.length_m) : "",
      conductivitySpm: extension ? String(extension.conductivity_spm) : "",
      layers: extension ? String(extension.layers ?? 2) : "2",
      direction: direction as [string, string, string],
      // No actuator current is inferred from port branch weights.
      currentA: currents && typeof currents[actuatorId] === "number" ? String(currents[actuatorId]) : "",
      ...(extension ? { loadedBoundaryMarkers: Array.isArray(extension.boundary_markers) ? extension.boundary_markers as number[] : [] } : {}),
    };
  }));
  if (preparation && (preparation.extensions as unknown[]).length !== rows.length) throw new Error("Existing preparation has additional controls; this form will not remove them.");
  return { key, baseRevision: scene.revision!, geometryBinding: antennaTerminalGeometryBinding(scene, objectId), portId,
    revision: typeof preparation?.revision === "string" ? preparation.revision : "", driveId: typeof drive?.id === "string" ? drive.id : `${port.id}:external-drive`, dirty: false, rows };
}

export function antennaTerminalPreparationErrors(scene: SceneResource, objectId: string, draft: AntennaTerminalPreparationDraft): string[] {
  try {
    if (!Number.isSafeInteger(draft.baseRevision) || draft.baseRevision < 0 || scene.revision !== draft.baseRevision) throw new Error("Scene changed. Refresh terminal bindings before applying.");
    const object = scene.objects?.find((item) => item.id === objectId);
    if (!object || object.locked) throw new Error("An unlocked antenna source object is required.");
    if (antennaTerminalGeometryBinding(scene, objectId) !== draft.geometryBinding) throw new Error("Geometry changed. Terminal bindings are invalid; reload and reselect the surfaces.");
    const geometry = record(object.geometry);
    const params = record(geometry?.geometry_params);
    if (!params || !["MicrostripAntennaLayout", "CPWAntennaLayout"].includes(String(geometry?.geometry_kind))) throw new Error("Only authored microstrip or CPW end caps are supported.");
    const conductors = Array.isArray(params.conductors) ? params.conductors.map(record).map((part) => part?.id) : [];
    const port = scene.antenna_port_modes?.find((item) => item.id === draft.portId && item.source_object_id === objectId);
    const transport = scene.current_transports?.find((item) => item.name === port?.current_transport_id);
    if (!port || !transport || transport.model !== "ohmic_poisson" || transport.coupling !== "one_way" || transport.conservative_current_source || transport.structured_current_closure) throw new Error("An existing static one-way Ohmic port transport without expert source or closure is required.");
    if (transport.time_envelope) throw new Error("Remove the transport time envelope explicitly before authoring a static inspection source.");
    const domain = transport.domain;
    const domainOwner = Array.isArray(domain) && domain.length === 1 ? record(domain[0]) : null;
    if (!domainOwner || domainOwner.object_id !== objectId || domainOwner.region_id) throw new Error("Preparation requires the complete original conductor object.");
    text(draft.revision, "Preparation revision");
    text(draft.driveId, "Drive ID");
    const solver = record(transport.solver);
    if (solver?.engine !== "cg" || solver.operator_version !== "fem_charge_conforming_h1_p1.transparent.v1") throw new Error("Preparation requires the existing FEM H1 CG solver policy.");
    if (port.branches.length !== conductors.length || port.branches.some((branch) => !conductors.includes(branch.id))) throw new Error("Port branch IDs must identify the actual authored conductor parts.");
    const expected = port.branches.flatMap((branch) => [branch.inlet_terminal_ref, branch.outlet_terminal_ref]);
    if (draft.rows.length !== expected.length || draft.rows.some((row) => !expected.includes(row.observationId)) || new Set(draft.rows.map((row) => row.observationId)).size !== expected.length) throw new Error("Each port observation must have exactly one explicit end cap.");
    const actorIds = new Set<string>();
    for (const row of draft.rows) {
      text(row.actuatorId, "External actuator ID");
      if (actorIds.has(row.actuatorId)) throw new Error("External actuator IDs must be distinct.");
      actorIds.add(row.actuatorId);
      const branch = port.branches.find((item) => item.id === row.conductorId);
      if (!branch || row.observationId !== (row.selector === "local_u_min" ? branch.inlet_terminal_ref : branch.outlet_terminal_ref)) throw new Error("End cap and port observation do not match.");
      if (number(row.lengthM, "lead length in m") <= 0 || number(row.conductivitySpm, "lead conductivity in S/m") <= 0) throw new Error("Lead length and conductivity must be positive.");
      const layers = number(row.layers, "lead layers");
      if (!Number.isSafeInteger(layers) || layers < 2 || layers > 1_048_576) throw new Error("Lead layers must be an integer in 2..1048576.");
      const direction = row.direction.map((value) => number(value, "world direction component"));
      if (Math.abs(Math.hypot(...direction) - 1) > 1e-12) throw new Error("Each world outward direction must be a unit vector; actual cap normals are checked at materialization.");
      number(row.currentA, "signed outward actuator current in A");
    }
    return [];
  } catch (error) { return [error instanceof Error ? error.message : String(error)]; }
}

export async function buildAntennaTerminalPreparationTransaction(scene: SceneResource, objectId: string, draft: AntennaTerminalPreparationDraft): Promise<Extract<AuthoringTransactionRequest, { kind: "merge_patch" }>> {
  const errors = antennaTerminalPreparationErrors(scene, objectId, draft);
  if (errors.length) throw new Error(errors[0]);
  const port = scene.antenna_port_modes!.find((item) => item.id === draft.portId)!;
  const extensions = await Promise.all(draft.rows.map(async (row): Promise<Extension> => ({
    id: row.actuatorId, observation_id: row.observationId, object_id: objectId,
    boundary_markers: [await antennaTerminalBoundaryMarker(objectId, row.conductorId, row.selector)],
    length_m: Number(row.lengthM), conductivity_spm: Number(row.conductivitySpm), layers: Number(row.layers), outward_direction_xyz: row.direction.map(Number),
  })));
  if (draft.rows.some((row, index) => row.loadedBoundaryMarkers && (row.loadedBoundaryMarkers.length !== 1 || row.loadedBoundaryMarkers[0] !== extensions[index].boundary_markers[0]))) throw new Error("Existing cap markers differ from the authored end-cap selector. Explicit surface rebinding is required; original controls were preserved.");
  if (new Set(extensions.flatMap((extension) => extension.boundary_markers)).size !== extensions.length) throw new Error("Terminal marker collision; no preparation was committed.");
  const preparation: AntennaLeadPreparation = { schema_version: "antenna_external_lead_preparation.v1", kind: "isolated_branch_straight_stubs", revision: draft.revision, extensions,
    drives: [{ id: draft.driveId, port_mode_ref: port.id, outer_terminal_currents_a: Object.fromEntries(draft.rows.map((row) => [row.actuatorId, Number(row.currentA)])) }] };
  const stages = scene.antenna_field_solve_stages ?? [];
  const dependents = stages.filter((stage) => stage.current_transport_id === port.current_transport_id);
  if (dependents.some((stage) => stage.source_object_id !== objectId || stage.port_mode_ids.length !== 1 || stage.port_mode_ids[0] !== port.id)) throw new Error("Transport is shared with another port or source; explicit rebinding is required.");
  return { kind: "merge_patch", base_revision: draft.baseRevision, merge_patch: {
    current_transports: scene.current_transports!.map((transport) => transport.name !== port.current_transport_id ? transport : {
      ...transport, boundaries: [], gauge: "terminal_reference", conservative_current_view: null, external_lead_preparation: preparation,
    }) as unknown as JsonObject[],
    antenna_field_solve_stages: stages.map((stage) => stage.current_transport_id !== port.current_transport_id ? stage : {
      ...stage, conservative_current_view_ref: null,
    }),
  } };
}

export function acknowledgeAntennaTerminalPreparationDraft(current: AntennaTerminalPreparationDraft | null, submitted: AntennaTerminalPreparationDraft, revision: number): AntennaTerminalPreparationDraft | null {
  if (!Number.isSafeInteger(revision) || revision <= submitted.baseRevision) throw new Error("Invalid terminal preparation ACK revision.");
  if (current?.key !== submitted.key || current.baseRevision !== submitted.baseRevision) return current;
  return { ...current, baseRevision: revision, dirty: current !== submitted };
}

/** Order-independent ACK identity for JSON maps and typed preparation records. */
export function antennaPreparationIdentity(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    const object = record(item);
    return object ? Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonical(object[key])])) : item;
  }
  return JSON.stringify(canonical(value));
}