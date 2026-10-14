export type MicrostripPoint = [number, number, number];

export interface AuthoredAntennaGeometry {
  positions: number[];
  indices: number[];
  parts: Array<{ id: string; indexStart: number; indexCount: number }>;
  boundsMin: MicrostripPoint;
  boundsMax: MicrostripPoint;
}

export type AuthoredMicrostripGeometry = AuthoredAntennaGeometry;

const PREVIEW_STATION_LIMIT = 8192;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Antenna layout requires canonical geometry parameters.");
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
  if (typeof value !== "string" || !value.trim()) throw new Error("Antenna part IDs must be non-empty strings.");
  return value;
}

/** Authored preview only: sections follow MicrostripAntennaLayout._sections, not a solver mesh. */
export function buildAuthoredMicrostripGeometry(paramsValue: unknown, outerValue: unknown): AuthoredMicrostripGeometry {
  return buildAuthoredAntennaGeometry("microstrip", paramsValue, outerValue);
}

/** Three disjoint lofts following CPWAntennaLayout._sections, not a solver mesh. */
export function buildAuthoredCpwGeometry(paramsValue: unknown, outerValue: unknown): AuthoredAntennaGeometry {
  return buildAuthoredAntennaGeometry("cpw", paramsValue, outerValue);
}

function buildAuthoredAntennaGeometry(kind: "microstrip" | "cpw", paramsValue: unknown, outerValue: unknown): AuthoredAntennaGeometry {
  const params = record(paramsValue);
  const length = number(params.length_m, "length_m", true);
  const thickness = number(params.thickness_m, "thickness_m", true);
  const returnWidth = kind === "microstrip" ? number(params.return_width_m, "return_width_m", true) : 0;
  const returnOffset = kind === "microstrip" ? number(params.return_offset_m, "return_offset_m") : 0;
  if (returnOffset < 0) throw new Error("return_offset_m must be non-negative.");
  const rawStations = params.stations;
  if (!Array.isArray(rawStations) || rawStations.length < 2) throw new Error("Antenna layout requires at least two width stations.");
  if (rawStations.length > PREVIEW_STATION_LIMIT) throw new Error(`Antenna authored preview supports at most ${PREVIEW_STATION_LIMIT} stations; use realized topology for larger layouts.`);
  const stations = rawStations.map((entry) => {
    const station = record(entry);
    return {
      s: number(station.s, "station s"),
      width: number(station.signal_width_m, "signal_width_m", true),
      leftGap: kind === "cpw" ? number(station.left_gap_m, "left_gap_m", true) : 0,
      rightGap: kind === "cpw" ? number(station.right_gap_m, "right_gap_m", true) : 0,
      leftWidth: kind === "cpw" ? number(station.left_ground_width_m, "left_ground_width_m", true) : 0,
      rightWidth: kind === "cpw" ? number(station.right_ground_width_m, "right_ground_width_m", true) : 0,
    };
  });
  if (stations[0].s !== 0 || stations.at(-1)?.s !== 1 || stations.some((station, index) => station.s < 0 || station.s > 1 || (index > 0 && station.s <= stations[index - 1].s))) throw new Error("Antenna stations must increase strictly from s=0 to s=1.");
  const inner = params.transform === undefined ? {} : record(params.transform);
  const rawRotation = inner.rotation_matrix ?? [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  if (!Array.isArray(rawRotation) || rawRotation.length !== 3) throw new Error("Antenna layout requires a proper 3x3 rotation matrix.");
  const rotation = rawRotation.map((row) => vector(row, "rotation_matrix"));
  const dot = (a: MicrostripPoint, b: MicrostripPoint) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const determinant = rotation[0][0] * (rotation[1][1] * rotation[2][2] - rotation[1][2] * rotation[2][1]) - rotation[0][1] * (rotation[1][0] * rotation[2][2] - rotation[1][2] * rotation[2][0]) + rotation[0][2] * (rotation[1][0] * rotation[2][1] - rotation[1][1] * rotation[2][0]);
  if (Math.abs(determinant - 1) > 1e-9 || rotation.some((row, index) => rotation.some((other, otherIndex) => Math.abs(dot(row, other) - (index === otherIndex ? 1 : 0)) > 1e-9))) throw new Error("Antenna rotation_matrix must be right-handed and orthonormal.");
  const innerTranslation = vector(inner.translation_m ?? [0, 0, 0], "translation_m");
  const outer = outerValue == null ? {} : record(outerValue);
  const translation = vector(outer.translation ?? [0, 0, 0], "object translation");
  const scale = vector(outer.scale ?? [1, 1, 1], "object scale");
  if (scale.some((value) => value <= 0)) throw new Error("Object scale must be positive.");
  const pivot = vector(outer.pivot ?? [0, 0, 0], "object pivot");
  if (pivot.some((value) => value !== 0)) throw new Error("Nonzero object pivot has no canonical antenna realization contract.");
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
  const conductorKinds = kind === "cpw" ? ["signal", "ground_left", "ground_right"] : ["signal", "return"];
  let conductorIds = [...conductorKinds];
  if (params.conductors !== undefined) {
    if (!Array.isArray(params.conductors) || params.conductors.length !== conductorKinds.length) throw new Error(`${kind} requires exactly ${conductorKinds.length} conductors.`);
    const conductors = params.conductors.map(record);
    conductorIds = conductorKinds.map((conductorKind) => {
      const matches = conductors.filter((conductor) => conductor.kind === conductorKind);
      if (matches.length !== 1) throw new Error(`${kind} requires exactly one ${conductorKind} conductor.`);
      return partId(matches[0].id);
    });
  }
  if (new Set(conductorIds).size !== conductorIds.length) throw new Error("Conductor part IDs must differ.");
  const positions: number[] = [];
  const indices: number[] = [];
  const parts: AuthoredAntennaGeometry["parts"] = [];
  const min: MicrostripPoint = [Infinity, Infinity, Infinity];
  const max: MicrostripPoint = [-Infinity, -Infinity, -Infinity];
  for (const [conductorIndex, id] of conductorIds.entries()) {
    const base = positions.length / 3;
    const indexStart = indices.length;
    for (const station of stations) {
      const width = conductorIndex === 0 ? station.width : kind === "microstrip" ? returnWidth : conductorIndex === 1 ? station.leftWidth : station.rightWidth;
      const centerY = kind === "microstrip" || conductorIndex === 0 ? 0 : conductorIndex === 1
        ? -(station.width / 2 + station.leftGap + width / 2)
        : station.width / 2 + station.rightGap + width / 2;
      const centerZ = kind === "microstrip" && conductorIndex === 1 ? -(thickness + returnOffset) : 0;
      for (const [y, z] of [[centerY - width / 2, centerZ - thickness / 2], [centerY + width / 2, centerZ - thickness / 2], [centerY + width / 2, centerZ + thickness / 2], [centerY - width / 2, centerZ + thickness / 2]]) {
        const point = worldPoint([station.s * length, y, z]);
        if (point.some((value) => !Number.isFinite(value))) throw new Error("Antenna transformed vertices exceed finite coordinate range.");
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
    throw new Error("Antenna authored preview exceeds resolved floating-point coordinate range.");
  }
  return { positions, indices, parts, boundsMin: min, boundsMax: max };
}
