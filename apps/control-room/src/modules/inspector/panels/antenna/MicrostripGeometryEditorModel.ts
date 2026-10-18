import type { JsonObject, SceneResource } from "@/kernel/api/apiTypes";

export interface WidthStationDraft {
  rowId: string;
  s: string;
  signalWidthM: string;
  leftGapM?: string;
  rightGapM?: string;
  leftGroundWidthM?: string;
  rightGroundWidthM?: string;
}

export const CPW_STATION_FIELDS = [
  { key: "leftGapM", parameter: "left_gap_m", label: "left gap" },
  { key: "rightGapM", parameter: "right_gap_m", label: "right gap" },
  { key: "leftGroundWidthM", parameter: "left_ground_width_m", label: "left ground width" },
  { key: "rightGroundWidthM", parameter: "right_ground_width_m", label: "right ground width" },
] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function microstripGeometry(scene: SceneResource | null, objectId: string): JsonObject | null {
  const geometry = antennaLayoutGeometry(scene, objectId);
  return geometry?.geometry_kind === "MicrostripAntennaLayout" ? geometry : null;
}

export function antennaLayoutGeometry(scene: SceneResource | null, objectId: string): JsonObject | null {
  const object = scene?.objects?.find((candidate) => candidate.id === objectId);
  const geometry = record(object?.geometry);
  return geometry?.geometry_kind === "MicrostripAntennaLayout" || geometry?.geometry_kind === "CPWAntennaLayout" ? geometry as JsonObject : null;
}

export function widthStationDraft(geometry: JsonObject, previous: WidthStationDraft[] = []): WidthStationDraft[] {
  const stations = record(geometry.geometry_params)?.stations;
  const rowIds = new Map(previous.filter((station) => station.s.trim() && Number.isFinite(Number(station.s)))
    .map((station) => [Number(station.s), station.rowId]));
  const reservedIds = new Set(previous.map((station) => station.rowId));
  const assignedIds = new Set<string>();
  return Array.isArray(stations) ? stations.map((entry, index) => {
    const station = record(entry);
    const s = String(station?.s ?? "");
    let rowId = s.trim() && Number.isFinite(Number(s)) ? rowIds.get(Number(s)) : undefined;
    if (!rowId || assignedIds.has(rowId)) {
      rowId = `source:${index}:${s}`;
      while (reservedIds.has(rowId) || assignedIds.has(rowId)) rowId += ":new";
    }
    assignedIds.add(rowId);
    const draft: WidthStationDraft = {
      rowId,
      s,
      signalWidthM: String(station?.signal_width_m ?? ""),
    };
    if (geometry.geometry_kind === "CPWAntennaLayout") {
      for (const field of CPW_STATION_FIELDS) draft[field.key] = String(station?.[field.parameter] ?? "");
    }
    return draft;
  }) : [];
}

function sameNumber(left: string, right: string): boolean {
  return Boolean(left.trim() && right.trim()) && Number.isFinite(Number(left)) && Number(left) === Number(right);
}

/** UI row identity and input formatting are not physical geometry changes. */
export function widthStationsEqual(left: WidthStationDraft[], right: WidthStationDraft[]): boolean {
  return left.length === right.length && left.every((station, index) =>
    sameNumber(station.s, right[index].s) && sameNumber(station.signalWidthM, right[index].signalWidthM)
    && CPW_STATION_FIELDS.every(({ key }) => {
      const a = station[key], b = right[index][key];
      return a === undefined && b === undefined || a !== undefined && b !== undefined && sameNumber(a, b);
    }));
}

const ANTENNA_LAYOUT_DIMENSION_FIELDS = [
  { parameter: "length_m", label: "Conductor length" },
  { parameter: "thickness_m", label: "Conductor thickness" },
  { parameter: "return_width_m", label: "Return width" },
  { parameter: "return_offset_m", label: "Return offset" },
] as const;

export function antennaLayoutDimensionFields(geometry: JsonObject) {
  return geometry.geometry_kind === "CPWAntennaLayout"
    ? ANTENNA_LAYOUT_DIMENSION_FIELDS.slice(0, 2) : ANTENNA_LAYOUT_DIMENSION_FIELDS;
}

export function antennaLayoutDimensionDraft(geometry: JsonObject): Record<string, string> {
  const params = record(geometry.geometry_params);
  return Object.fromEntries(antennaLayoutDimensionFields(geometry)
    .map(({ parameter }) => [parameter, String(params?.[parameter] ?? "")]));
}

export function antennaLayoutDimensionsEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  return Object.keys(left).length === Object.keys(right).length
    && Object.entries(left).every(([key, value]) => right[key] !== undefined && sameNumber(value, right[key]));
}

export function insertWidthStation(stations: WidthStationDraft[], rowId: string): WidthStationDraft[] {
  if (stations.length < 2) return stations;
  let widestIndex = 0;
  let widestGap = -Infinity;
  for (let index = 0; index < stations.length - 1; index += 1) {
    const gap = Number(stations[index + 1].s) - Number(stations[index].s);
    if (gap > widestGap) {
      widestGap = gap;
      widestIndex = index;
    }
  }
  if (!Number.isFinite(widestGap) || widestGap <= 0) return stations;
  const left = stations[widestIndex];
  const right = stations[widestIndex + 1];
  const station: WidthStationDraft = {
    rowId,
    s: String((Number(left.s) + Number(right.s)) / 2),
    signalWidthM: String((Number(left.signalWidthM) + Number(right.signalWidthM)) / 2),
  };
  for (const { key } of CPW_STATION_FIELDS) {
    if (left[key] !== undefined || right[key] !== undefined) {
      station[key] = left[key]?.trim() && right[key]?.trim()
        ? String((Number(left[key]) + Number(right[key])) / 2) : "";
    }
  }
  return [...stations.slice(0, widestIndex + 1), station, ...stations.slice(widestIndex + 1)];
}

export function buildMicrostripGeometry(geometry: JsonObject, stations: WidthStationDraft[]): JsonObject {
  if (geometry.geometry_kind !== "MicrostripAntennaLayout") throw new Error("A canonical MicrostripAntennaLayout is required.");
  return buildAntennaLayoutGeometry(geometry, stations);
}

export function buildAntennaLayoutGeometry(geometry: JsonObject, stations: WidthStationDraft[], dimensions?: Record<string, string>): JsonObject {
  const params = record(geometry.geometry_params);
  if ((geometry.geometry_kind !== "MicrostripAntennaLayout" && geometry.geometry_kind !== "CPWAntennaLayout") || !params) {
    throw new Error("A canonical MicrostripAntennaLayout or CPWAntennaLayout is required.");
  }
  const authoredDimensions: JsonObject = {};
  if (dimensions) {
    for (const { parameter, label } of antennaLayoutDimensionFields(geometry)) {
      const value = dimensions[parameter];
      const allowZero = parameter === "return_offset_m";
      if (!value?.trim() || !Number.isFinite(Number(value)) || (allowZero ? Number(value) < 0 : Number(value) <= 0)) {
        throw new Error(`${label} must be finite and ${allowZero ? "non-negative" : "positive"} in m.`);
      }
      authoredDimensions[parameter] = Number(value);
    }
  }
  if (stations.length < 2) throw new Error("At least two width stations are required.");
  const parsed = stations.map((station, index) => {
    if (!station.s.trim() || !station.signalWidthM.trim()) {
      throw new Error(`Station ${index + 1} requires position and signal width.`);
    }
    const s = Number(station.s);
    const signalWidthM = Number(station.signalWidthM);
    if (!Number.isFinite(s) || s < 0 || s > 1) {
      throw new Error(`Station ${index + 1} position must lie in [0, 1].`);
    }
    if (!Number.isFinite(signalWidthM) || signalWidthM <= 0) {
      throw new Error(`Station ${index + 1} signal width must be positive in m.`);
    }
    if (index > 0 && s <= Number(stations[index - 1].s)) {
      throw new Error("Width station positions must be strictly increasing.");
    }
    const result: JsonObject = { s, signal_width_m: signalWidthM };
    if (geometry.geometry_kind === "CPWAntennaLayout") {
      for (const field of CPW_STATION_FIELDS) {
        const value = station[field.key];
        if (!value?.trim() || !Number.isFinite(Number(value)) || Number(value) <= 0) {
          throw new Error(`Station ${index + 1} ${field.label} must be positive in m.`);
        }
        result[field.parameter] = Number(value);
      }
    }
    return result;
  });
  if (parsed[0].s !== 0 || parsed.at(-1)?.s !== 1) {
    throw new Error("Width stations must start at s=0 and end at s=1.");
  }
  return {
    geometry_kind: geometry.geometry_kind,
    geometry_params: { ...params, ...authoredDimensions, stations: parsed } as JsonObject,
  };
}

export const MICROSTRIP_LOOP_FIELDS = (["inlet", "outlet"] as const).flatMap((end) => [
  { key: `${end}_connection_length_m`, label: `${end} bridge length`, unit: "m", numeric: true },
  { key: `${end}_connection_width_m`, label: `${end} bridge width`, unit: "m", numeric: true },
  { key: `${end}_connection_offset_v_m`, label: `${end} bridge center v`, unit: "m", numeric: true },
  { key: `${end}_connection_part_id`, label: `${end} bridge part ID`, unit: undefined, numeric: false },
  { key: `${end}_connection_conductivity_s_per_m`, label: `${end} bridge conductivity`, unit: "S/m", numeric: true },
]);

export interface MicrostripCircuitDraft {
  enabled: boolean;
  parameters: Record<string, string>;
  potentialJumpV: string;
}

export function microstripCircuitDraft(geometry: JsonObject, scene: SceneResource | null, objectId: string): MicrostripCircuitDraft {
  const loop = record(record(geometry.geometry_params)?.loop);
  const currents = scene?.current_transports?.map(record).filter((current) => Array.isArray(current?.domain)
    && current.domain.some((ref) => record(ref)?.object_id === objectId)) ?? [];
  const closure = record(currents.length === 1 ? currents[0]?.structured_current_closure : null);
  const cuts = Array.isArray(closure?.source_cuts) ? closure.source_cuts : [];
  const drive = record(record(cuts.length === 1 ? cuts[0] : null)?.drive);
  return { enabled: loop?.enabled === true,
    parameters: Object.fromEntries(MICROSTRIP_LOOP_FIELDS.map(({ key }) => [key, String(loop?.[key] ?? "")])),
    potentialJumpV: String(drive?.potential_jump_V ?? "") };
}

export function microstripCircuitEqual(left: MicrostripCircuitDraft, right: MicrostripCircuitDraft): boolean {
  return left.enabled === right.enabled && (!left.enabled || (
    MICROSTRIP_LOOP_FIELDS.every(({ key, numeric }) => numeric
      ? sameNumber(left.parameters[key], right.parameters[key]) : (left.parameters[key] ?? "").trim() === (right.parameters[key] ?? "").trim())
    && sameNumber(left.potentialJumpV, right.potentialJumpV)));
}

/** One authored transaction: geometry, charge module and port share the same source-cut identity. */
export function buildMicrostripCircuitPatch(scene: SceneResource, objectId: string, geometry: JsonObject, draft: MicrostripCircuitDraft): JsonObject {
  const object = scene.objects?.find((candidate) => candidate.id === objectId);
  const params = record(geometry.geometry_params);
  if (!object || geometry.geometry_kind !== "MicrostripAntennaLayout" || !params || !draft.enabled) {
    throw new Error("An explicitly enabled canonical microstrip circuit is required.");
  }
  if (object.locked) throw new Error("Unlock this object before changing circuit geometry or actuation.");
  const outer = record(object.transform);
  const identity = (value: unknown, expected: number[]) => value === undefined || Array.isArray(value)
    && value.length === expected.length && value.every((entry, index) => entry === expected[index]);
  const quaternion = outer?.rotation_quat ?? [0, 0, 0, 1];
  if (!Array.isArray(quaternion) || quaternion.length !== 4 || quaternion.some((value) => typeof value !== "number" || !Number.isFinite(value))
    || Math.abs(Math.hypot(...quaternion as number[]) - 1) > 1e-9) throw new Error("Owner rotation requires a unit quaternion.");
  if (!identity(outer?.rotation, [0, 0, 0]) || !identity(outer?.scale, [1, 1, 1]) || !identity(outer?.pivot, [0, 0, 0])) {
    throw new Error("Full circuits require unit owner scale, zero pivot and canonical quaternion rotation. Use a rigid transform for reproducible Python export.");
  }
  const finite = (text: string, label: string, positive = false) => {
    if (!text?.trim() || !Number.isFinite(Number(text)) || positive && Number(text) <= 0) {
      throw new Error(`${label} must be a finite${positive ? " positive" : ""} SI value.`);
    }
    return Number(text);
  };
  const loop: JsonObject = { enabled: true };
  for (const { key, numeric, label, unit } of MICROSTRIP_LOOP_FIELDS) {
    const text = draft.parameters[key];
    if (!numeric && !text?.trim()) throw new Error(`${label} must be a non-empty part ID.`);
    loop[key] = numeric ? finite(text, `${label}${unit ? ` (${unit})` : ""}`, !key.endsWith("offset_v_m")) : text.trim();
  }
  const thickness = finite(String(params.thickness_m ?? ""), "thickness_m", true);
  const gap = finite(String(params.return_offset_m ?? ""), "return_offset_m", true);
  const sigma = finite(String(params.conductivity_s_per_m ?? ""), "conductivity_s_per_m", true);
  const conductors = Array.isArray(params.conductors) ? params.conductors.map(record) : [];
  const signal = conductors.find((part) => part?.kind === "signal")?.id;
  const returnPart = conductors.find((part) => part?.kind === "return")?.id;
  if (typeof signal !== "string" || typeof returnPart !== "string") throw new Error("Explicit signal and return part IDs are required.");
  const ids = [signal, returnPart, loop.inlet_connection_part_id, loop.outlet_connection_part_id];
  if (new Set(ids).size !== 4) throw new Error("All four circuit part IDs must differ.");
  const stations = Array.isArray(params.stations) ? params.stations.map(record) : [];
  for (const [end, station] of [["inlet", stations[0]], ["outlet", stations.at(-1)]] as const) {
    const offset = Number(loop[`${end}_connection_offset_v_m`]);
    const width = Number(loop[`${end}_connection_width_m`]);
    for (const conductorWidth of [Number(station?.signal_width_m), Number(params.return_width_m)]) {
      if (!(Math.min(offset + width / 2, conductorWidth / 2) > Math.max(offset - width / 2, -conductorWidth / 2))) {
        throw new Error(`${end} bridge must contact signal and return with positive area.`);
      }
    }
  }
  const potential = finite(draft.potentialJumpV, "Source-cut potential jump");
  if (potential === 0) throw new Error("Source-cut potential jump must be non-zero in V.");
  const currents = scene.current_transports ?? [];
  const matches = currents.map(record).filter((current) => Array.isArray(current?.domain)
    && current.domain.some((ref) => record(ref)?.object_id === objectId));
  if (matches.length !== 1) throw new Error("The circuit requires exactly one explicitly authored charge transport for this object.");
  const current = matches[0]!;
  if (current.model !== "ohmic_poisson" || current.coupling !== "one_way"
    || !Array.isArray(current.domain) || current.domain.length !== 1 || record(current.domain[0])?.region_id !== undefined) {
    throw new Error("Full circuits require one whole-object, one-way ohmic charge transport.");
  }
  const ports = scene.antenna_port_modes ?? [];
  const matchingPorts = ports.map(record).filter((port) => port?.source_object_id === objectId && port.current_transport_id === current.name);
  if (matchingPorts.length !== 1) throw new Error("The circuit requires exactly one existing explicit signal/return observation port.");
  const port = matchingPorts[0]!;
  const branches = Array.isArray(port.branches) ? port.branches.map(record) : [];
  const refs = branches.flatMap((branch) => [branch?.inlet_terminal_ref, branch?.outlet_terminal_ref]);
  if (branches.length !== 2 || branches.some((branch) => ![signal, returnPart].includes(String(branch?.id)))
    || new Set(branches.map((branch) => branch?.id)).size !== 2
    || refs.some((ref) => typeof ref !== "string" || !ref.trim()) || new Set(refs).size !== 4) {
    throw new Error("The port must retain two explicit conductor branches and four distinct observation IDs.");
  }
  const assignments = Array.isArray(current.materials) ? current.materials.map(record) : [];
  const mainMaterials = [signal, returnPart].map((id) => {
    const matching = assignments.filter((assignment) => record(assignment?.region)?.object_id === objectId
      && (record(assignment?.region)?.region_id === undefined || record(assignment?.region)?.region_id === id));
    if (matching.length !== 1 || record(matching[0]?.material)?.sigma_Spm !== sigma) {
      throw new Error("Signal/return charge conductivity must agree with authored geometry, with exactly one assignment per part. Resolve materials explicitly first.");
    }
    return record(matching[0]?.material)!;
  });
  const oldClosure = record(current.structured_current_closure);
  if (oldClosure && oldClosure.schema_version !== "structured_current_closure.v2") throw new Error("Migrate the existing closure explicitly before authoring a full circuit.");
  if (!oldClosure && (current.external_lead_preparation || current.conservative_current_source || current.conservative_current_view)) {
    throw new Error("Remove the existing explicit current preparation before selecting closed-geometry actuation.");
  }
  const cuts = Array.isArray(oldClosure?.source_cuts) ? oldClosure.source_cuts : [];
  if (oldClosure && cuts.length !== 1) throw new Error("Exactly one inlet source cut is required.");
  const oldCut = record(cuts[0]);
  const cutId = String(oldCut?.source_cut_id ?? `${objectId}:source-cut:inlet`);
  const driveId = String(record(oldCut?.drive)?.drive_id ?? `${objectId}:source-drive`);
  const oldPlane = record(oldCut?.plane);
  if (oldPlane && (oldPlane.coordinate_frame !== "object" || oldPlane.axis !== "z"
    || !["positive_axis", "negative_axis"].includes(String(oldPlane.normal)))) {
    throw new Error("The existing source cut must explicitly use object-local z and an axis normal.");
  }
  const cutOffset = oldPlane ? finite(String(oldPlane.offset_m ?? ""), "Source-cut offset") : -(thickness + gap) / 2;
  if (!(cutOffset > -thickness / 2 - gap && cutOffset < -thickness / 2)) throw new Error("The source cut must lie strictly inside the signal/return clearance.");
  const closure: JsonObject = { schema_version: "structured_current_closure.v2", closure_id: String(oldClosure?.closure_id ?? `${objectId}:closed-loop`), kind: "closed_geometry",
    source_cuts: [{ source_cut_id: cutId, circuit_id: String(oldCut?.circuit_id ?? `${objectId}:circuit`),
      region: { object_id: objectId, region_id: loop.inlet_connection_part_id },
      plane: { coordinate_frame: "object", axis: "z", offset_m: cutOffset, normal: String(oldPlane?.normal ?? "positive_axis") },
      drive: { schema_version: "impressed_potential_jump.v1", kind: "impressed_potential_jump", drive_id: driveId, potential_jump_V: potential } }] };
  const patchedCurrent: JsonObject = { ...current, boundaries: [], gauge: "zero_mean",
    materials: ids.map((id, index) => ({ region: { object_id: objectId, region_id: id }, material: index < 2 ? mainMaterials[index] : { sigma_Spm: loop[`${index === 2 ? "inlet" : "outlet"}_connection_conductivity_s_per_m`] } })),
    structured_current_closure: closure,
    solver: { ...record(current.solver), engine: "cg", linear: { relative_tolerance: 1e-12, absolute_tolerance: 0, max_iterations: 10000 },
      operator_version: "fem_charge_conforming_h1_p1.transparent.v1", physical_residual_version: "charge_balance_integrated_l2.v1" } } as JsonObject;
  for (const key of ["external_lead_preparation", "conservative_current_source", "conservative_current_view", "closure_receipts"]) delete patchedCurrent[key];
  const patchedGeometry: JsonObject = { ...geometry, geometry_params: { ...params, loop } as JsonObject };
  return { objects: (scene.objects ?? []).map((candidate) => candidate.id === objectId ? { ...candidate, geometry: patchedGeometry } : candidate),
    current_transports: currents.map((candidate) => record(candidate)?.name === current.name ? patchedCurrent : candidate),
    antenna_port_modes: ports.map((candidate) => record(candidate)?.id === port.id
      ? { ...port, schema_version: "antenna_port_mode.v3", normalization: { kind: "source_cut_rt0", source_cut_ref: cutId, orientation: "minus_outward" } } : candidate),
    antenna_field_solve_stages: (scene.antenna_field_solve_stages ?? []).map((stage) => {
      if (stage.source_object_id !== objectId || stage.current_transport_id !== current.name) return stage;
      const patched = { ...stage };
      delete patched.conservative_current_view_ref;
      return patched;
    }) } as JsonObject;
}

export function microstripCircuitSourceKey(geometry: JsonObject, scene: SceneResource | null, objectId: string): string {
  const currents = scene?.current_transports?.filter((current) => Array.isArray(record(current)?.domain)
    && (record(current)!.domain as unknown[]).some((ref) => record(ref)?.object_id === objectId)) ?? [];
  return JSON.stringify([geometry, currents, scene?.antenna_port_modes?.filter((port) => port.source_object_id === objectId)]);
}
