export type MicrostripPoint = [number, number, number];

export interface AuthoredMicrostripGeometry {
  positions: number[];
  indices: number[];
  parts: Array<{ id: string; indexStart: number; indexCount: number }>;
  boundsMin: MicrostripPoint;
  boundsMax: MicrostripPoint;
}

const PREVIEW_STATION_LIMIT = 8192;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Microstrip requires canonical geometry parameters.");
  return value as Record<string, unknown>;
}

function number(value: unknown, label: string, positive = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || (positive && value <= 0)) throw new Error(`${label} must be a finite${positive ? " positive" : ""} SI value.`);
  return value;
}

function vector(value: unknown, label: string): MicrostripPoint {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${label} requires three finite components.`);
  return [number(value[0], label), number(value[1], label), number(value[2], label)];
}

function partId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Microstrip part IDs must be non-empty strings.");
  return value;
}

/** Authored preview only: sections follow MicrostripAntennaLayout._sections, not a solver mesh. */
export function buildAuthoredMicrostripGeometry(paramsValue: unknown, outerValue: unknown): AuthoredMicrostripGeometry {
  const params = record(paramsValue);
  const length = number(params.length_m, "length_m", true);
  const thickness = number(params.thickness_m, "thickness_m", true);
  const returnWidth = number(params.return_width_m, "return_width_m", true);
  const returnOffset = number(params.return_offset_m, "return_offset_m");
  if (returnOffset < 0) throw new Error("return_offset_m must be non-negative.");
  const rawStations = params.stations;
  if (!Array.isArray(rawStations) || rawStations.length < 2) throw new Error("Microstrip requires at least two width stations.");
  if (rawStations.length > PREVIEW_STATION_LIMIT) throw new Error(`Microstrip authored preview supports at most ${PREVIEW_STATION_LIMIT} stations; use realized topology for larger layouts.`);
  const stations = rawStations.map((entry) => {
    const station = record(entry);
    return { s: number(station.s, "station s"), width: number(station.signal_width_m, "signal_width_m", true) };
  });
  if (stations[0].s !== 0 || stations.at(-1)?.s !== 1 || stations.some((station, index) => station.s < 0 || station.s > 1 || (index > 0 && station.s <= stations[index - 1].s))) throw new Error("Microstrip stations must increase strictly from s=0 to s=1.");
  const inner = params.transform === undefined ? {} : record(params.transform);
  const rawRotation = inner.rotation_matrix ?? [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  if (!Array.isArray(rawRotation) || rawRotation.length !== 3) throw new Error("Microstrip requires a proper 3x3 rotation matrix.");
  const rotation = rawRotation.map((row) => vector(row, "rotation_matrix"));
  const dot = (a: MicrostripPoint, b: MicrostripPoint) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const determinant = rotation[0][0] * (rotation[1][1] * rotation[2][2] - rotation[1][2] * rotation[2][1]) - rotation[0][1] * (rotation[1][0] * rotation[2][2] - rotation[1][2] * rotation[2][0]) + rotation[0][2] * (rotation[1][0] * rotation[2][1] - rotation[1][1] * rotation[2][0]);
  if (Math.abs(determinant - 1) > 1e-9 || rotation.some((row, index) => rotation.some((other, otherIndex) => Math.abs(dot(row, other) - (index === otherIndex ? 1 : 0)) > 1e-9))) throw new Error("Microstrip rotation_matrix must be right-handed and orthonormal.");
  const innerTranslation = vector(inner.translation_m ?? [0, 0, 0], "translation_m");
  const outer = outerValue == null ? {} : record(outerValue);
  const translation = vector(outer.translation ?? [0, 0, 0], "object translation");
  const scale = vector(outer.scale ?? [1, 1, 1], "object scale");
  if (scale.some((value) => value <= 0)) throw new Error("Object scale must be positive.");
  const pivot = vector(outer.pivot ?? [0, 0, 0], "object pivot");
  if (pivot.some((value) => value !== 0)) throw new Error("Nonzero object pivot has no canonical Microstrip realization contract.");
  const rawQuat = outer.rotation_quat ?? [0, 0, 0, 1];
  if (!Array.isArray(rawQuat) || rawQuat.length !== 4) throw new Error("Object rotation_quat requires four finite components.");
  const q = rawQuat.map((value) => number(value, "rotation_quat"));
  if (Math.abs(Math.hypot(...q) - 1) > 1e-9) throw new Error("Object rotation_quat must be a unit quaternion.");
  const [qx, qy, qz, qw] = q;
  const worldPoint = (local: MicrostripPoint): MicrostripPoint => {
    const p = rotation.map((row, axis) => (dot(row, local) + innerTranslation[axis]) * scale[axis]);
    const tx = 2 * (qy * p[2] - qz * p[1]);
    const ty = 2 * (qz * p[0] - qx * p[2]);
    const tz = 2 * (qx * p[1] - qy * p[0]);
    return [p[0] + qw * tx + qy * tz - qz * ty + translation[0], p[1] + qw * ty + qz * tx - qx * tz + translation[1], p[2] + qw * tz + qx * ty - qy * tx + translation[2]];
  };
  let signalId = "signal";
  let returnId = "return";
  if (params.conductors !== undefined) {
    if (!Array.isArray(params.conductors) || params.conductors.length !== 2) throw new Error("Microstrip requires exactly one signal and one return conductor.");
    const conductors = params.conductors.map(record);
    const signal = conductors.filter((conductor) => conductor.kind === "signal");
    const returns = conductors.filter((conductor) => conductor.kind === "return");
    if (signal.length !== 1 || returns.length !== 1) throw new Error("Microstrip conductor kinds must be signal and return.");
    signalId = partId(signal[0].id);
    returnId = partId(returns[0].id);
  }
  if (signalId === returnId) throw new Error("Signal and return part IDs must differ.");
  const positions: number[] = [];
  const indices: number[] = [];
  const parts: AuthoredMicrostripGeometry["parts"] = [];
  const min: MicrostripPoint = [Infinity, Infinity, Infinity];
  const max: MicrostripPoint = [-Infinity, -Infinity, -Infinity];
  for (const [id, returnPart] of [[signalId, false], [returnId, true]] as const) {
    const base = positions.length / 3;
    const indexStart = indices.length;
    for (const station of stations) {
      const width = returnPart ? returnWidth : station.width;
      const centerZ = returnPart ? -(thickness + returnOffset) : 0;
      for (const [y, z] of [[-width / 2, centerZ - thickness / 2], [width / 2, centerZ - thickness / 2], [width / 2, centerZ + thickness / 2], [-width / 2, centerZ + thickness / 2]]) {
        const point = worldPoint([station.s * length, y, z]);
        if (point.some((value) => !Number.isFinite(value))) throw new Error("Microstrip transformed vertices exceed finite coordinate range.");
        positions.push(...point);
        for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], point[axis]); max[axis] = Math.max(max[axis], point[axis]); }
      }
    }
    for (let station = 0; station < stations.length - 1; station++) {
      for (let side = 0; side < 4; side++) {
        const a = base + station * 4 + side, b = base + station * 4 + (side + 1) % 4;
        const c = b + 4, d = a + 4;
        indices.push(a, b, c, a, c, d);
      }
    }
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    const end = base + (stations.length - 1) * 4;
    indices.push(end, end + 1, end + 2, end, end + 2, end + 3);
    parts.push({ id, indexStart, indexCount: indices.length - indexStart });
  }
  if (max.some((value, axis) => value <= min[axis] || !Number.isFinite(Math.fround(value - min[axis])))) {
    throw new Error("Microstrip authored preview exceeds resolved floating-point coordinate range.");
  }
  return { positions, indices, parts, boundsMin: min, boundsMax: max };
}
