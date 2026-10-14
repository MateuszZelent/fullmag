import type { AntennaFieldIntent } from "@/kernel/visualization/antennaFieldIntent";

export const MAX_ANTENNA_DISPLAY_SAMPLES = 100_000;
export const MAX_ANTENNA_DISPLAY_PAYLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_ANTENNA_DISPLAY_CELLS = 100_000;

export interface AntennaDisplayDescriptor {
  scalar_type: string;
  layout: string;
  unit: string;
  value_count: number;
  sha256: string;
  byte_count?: number;
}

export interface AntennaFieldOverlayModel {
  key: string;
  positions: Float32Array;
  scalarValues: Float64Array;
  vectorSegments: Float32Array | null;
  surfaceTriangles: Uint32Array | null;
  surfaceEdges: Uint32Array | null;
  surfacePositions?: Float32Array;
  surfaceVectorValues?: Float32Array;
  surfaceVectorScale?: number;
  wirePositions?: Float32Array;
  minimum: number;
  maximum: number;
  count: number;
  intent: AntennaFieldIntent;
}

export function antennaDisplayShape(positions: AntennaDisplayDescriptor, values: AntennaDisplayDescriptor, intent: AntennaFieldIntent): number {
  const scalar = intent.quantity === "electric_potential_per_ampere" || intent.quantity === "device_potential";
  const magnetic = intent.quantity === "magnetic_field_per_ampere" || intent.quantity === "magnetic_field";
  const current = intent.quantity === "current_density";
  const expectedUnit = intent.kind === "inspection" ? scalar ? "V" : current ? "A/m^2" : "A/m" : scalar ? "V/A" : magnetic ? "A/m/A" : "A/m^2/A";
  const count = positions.value_count / 3;
  if (positions.scalar_type !== "float64_le" || values.scalar_type !== "float64_le" ||
      positions.layout !== (current ? "cell_xyz_interleaved" : magnetic ? "sample_xyz_interleaved" : "node_xyz_interleaved") ||
      values.layout !== (current ? "cell_vector_xyz_interleaved" : intent.quantity === "device_potential" ? "authored_device_vertex_order" : scalar ? "node_scalar" : "sample_xyz_interleaved") ||
      positions.unit !== "m" || values.unit !== expectedUnit ||
      !Number.isSafeInteger(count) || count <= 0 || count > MAX_ANTENNA_DISPLAY_SAMPLES ||
      values.value_count !== count * (scalar ? 1 : 3) ||
      (positions.value_count + values.value_count) * 8 > MAX_ANTENNA_DISPLAY_PAYLOAD_BYTES ||
      !/^[a-f0-9]{64}$/i.test(positions.sha256) || !/^[a-f0-9]{64}$/i.test(values.sha256) ||
      (positions.byte_count !== undefined && positions.byte_count !== positions.value_count * 8) ||
      (values.byte_count !== undefined && values.byte_count !== values.value_count * 8) ||
      (intent.kind === "inspection" ? !["device_potential", "current_density", "magnetic_field"].includes(intent.quantity) : ["device_potential", "current_density", "magnetic_field"].includes(intent.quantity))) {
    throw new Error("Antenna display requires compatible complete SI payloads (maximum 100000 samples / 64 MiB); no automatic decimation.");
  }
  return count;
}

export function antennaDisplayTopologyShape(topology: AntennaDisplayDescriptor, nodeCount: number, cellCount: number, positions: AntennaDisplayDescriptor, values: AntennaDisplayDescriptor): void {
  if (topology.scalar_type !== "uint32_le" || topology.layout !== "tet4_connectivity" || topology.unit !== "1" ||
      !Number.isSafeInteger(cellCount) || cellCount <= 0 || cellCount > MAX_ANTENNA_DISPLAY_CELLS ||
      topology.value_count !== cellCount * 4 || topology.byte_count !== cellCount * 16 ||
      !Number.isSafeInteger(nodeCount) || nodeCount !== positions.value_count / 3 || values.value_count !== nodeCount ||
      !/^[a-f0-9]{64}$/i.test(topology.sha256) ||
      (positions.value_count + values.value_count) * 8 + topology.byte_count > MAX_ANTENNA_DISPLAY_PAYLOAD_BYTES) {
    throw new Error("Antenna V display requires complete bounded device Tet4 connectivity and matching authored device vertex order.");
  }
}

/** Derive only the exterior of the retained Tet4 carrier; vertex ordering need not encode orientation. */
export function deviceBoundary(positionPayload: ArrayBuffer, topologyPayload: ArrayBuffer, nodeCount: number): { triangles: Uint32Array; localTriangles: Uint32Array; edges: Uint32Array } {
  if (topologyPayload.byteLength === 0 || topologyPayload.byteLength % 16 !== 0 || topologyPayload.byteLength / 16 > MAX_ANTENNA_DISPLAY_CELLS) throw new Error("Invalid device Tet4 payload length.");
  const coordinates = new DataView(positionPayload), cells = new DataView(topologyPayload);
  const faces = new Map<string, { nodes: number[]; localNodes: number[]; count: number; oppositeSide: number }>();
  const seenCells = new Set<string>();
  const usedNodes = new Set<number>();
  const point = (id: number) => [0, 1, 2].map((axis) => coordinates.getFloat64((id * 3 + axis) * 8, true));
  const side = (face: number[], opposite: number) => {
    const a = point(face[0]), b = point(face[1]), c = point(face[2]), d = point(opposite);
    const u = b.map((value, axis) => value - a[axis]), v = c.map((value, axis) => value - a[axis]), w = d.map((value, axis) => value - a[axis]);
    const scale = Math.max(...u.map(Math.abs), ...v.map(Math.abs), ...w.map(Math.abs));
    if (!(scale > 0) || !Number.isFinite(scale)) throw new Error("Degenerate or unrepresentable device Tet4.");
    const [ux, uy, uz] = u.map((value) => value / scale), [vx, vy, vz] = v.map((value) => value / scale), [wx, wy, wz] = w.map((value) => value / scale);
    const determinant = (uy * vz - uz * vy) * wx + (uz * vx - ux * vz) * wy + (ux * vy - uy * vx) * wz;
    if (!Number.isFinite(determinant) || determinant === 0) throw new Error("Degenerate device Tet4.");
    return Math.sign(determinant);
  };
  for (let offset = 0; offset < topologyPayload.byteLength; offset += 16) {
    const tet = [0, 1, 2, 3].map((index) => cells.getUint32(offset + index * 4, true));
    if (new Set(tet).size !== 4 || tet.some((id) => id >= nodeCount)) throw new Error("Device Tet4 has duplicate or out-of-range vertex indices.");
    const cellKey = [...tet].sort((a, b) => a - b).join(":");
    if (seenCells.has(cellKey)) throw new Error("Duplicate device Tet4.");
    seenCells.add(cellKey);
    for (const id of tet) usedNodes.add(id);
    for (let omitted = 0; omitted < 4; omitted += 1) {
      const face = tet.filter((_, index) => index !== omitted).sort((a, b) => a - b);
      const orientation = side(face, tet[omitted]), key = face.join(":");
      const previous = faces.get(key);
      if (previous) {
        if (previous.count !== 1 || previous.oppositeSide === orientation) throw new Error("Device Tet4 boundary is non-manifold or overlapping.");
        previous.count = 2;
      } else {
        // Outward normal points away from the opposite vertex.
        const nodes = orientation > 0 ? [face[0], face[2], face[1]] : face;
        faces.set(key, { nodes, localNodes: nodes.map((id) => offset / 4 + tet.indexOf(id)), count: 1, oppositeSide: orientation });
      }
    }
  }
  if (usedNodes.size !== nodeCount) throw new Error("Device Tet4 does not cover its published node carrier.");
  const triangles: number[] = [], localTriangles: number[] = [], edges = new Map<string, { nodes: number[]; count: number }>();
  for (const face of faces.values()) if (face.count === 1) {
    triangles.push(...face.nodes);
    localTriangles.push(...face.localNodes);
    for (let index = 0; index < 3; index += 1) {
      const pair = [face.nodes[index], face.nodes[(index + 1) % 3]].sort((a, b) => a - b), key = pair.join(":");
      const previous = edges.get(key);
      if (previous) previous.count += 1;
      else edges.set(key, { nodes: pair, count: 1 });
    }
  }
  if (triangles.length === 0 || [...edges.values()].some((edge) => edge.count !== 2)) throw new Error("Device Tet4 exterior is not a closed manifold surface.");
  return { triangles: new Uint32Array(triangles), localTriangles: new Uint32Array(localTriangles), edges: new Uint32Array([...edges.values()].flatMap((edge) => edge.nodes)) };
}

/** Full immutable payload projection; no mesh, interpolation or invented field values. */
export function buildAntennaFieldOverlayModel(positionPayload: ArrayBuffer, fieldPayload: ArrayBuffer, count: number, intent: AntennaFieldIntent, topologyPayload?: ArrayBuffer): AntennaFieldOverlayModel {
  const scalar = intent.quantity === "electric_potential_per_ampere" || intent.quantity === "device_potential";
  if (!Number.isSafeInteger(count) || count <= 0 || count > MAX_ANTENNA_DISPLAY_SAMPLES ||
      positionPayload.byteLength !== count * 24 || fieldPayload.byteLength !== count * (scalar ? 8 : 24)) {
    throw new Error("Antenna display payload cardinality differs from its pinned manifest.");
  }
  const positions = new Float32Array(count * 3);
  const scalarValues = new Float64Array(count);
  const positionView = new DataView(positionPayload);
  const fieldView = new DataView(fieldPayload);
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  let minimum = Infinity;
  let maximum = -Infinity;
  let maximumNorm = 0;
  for (let i = 0; i < count; i += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positionView.getFloat64((i * 3 + axis) * 8, true);
      if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) throw new Error("Non-finite antenna coordinate.");
      positions[i * 3 + axis] = value;
      low[axis] = Math.min(low[axis], value);
      high[axis] = Math.max(high[axis], value);
    }
    const x = fieldView.getFloat64(i * (scalar ? 8 : 24), true);
    const y = scalar ? 0 : fieldView.getFloat64(i * 24 + 8, true);
    const z = scalar ? 0 : fieldView.getFloat64(i * 24 + 16, true);
    if (![x, y, z].every(Number.isFinite)) throw new Error("Non-finite antenna field value.");
    const norm = Math.hypot(x, y, z);
    if (!Number.isFinite(norm)) throw new Error("Non-finite antenna field magnitude.");
    maximumNorm = Math.max(maximumNorm, norm);
    const value = scalar ? x : intent.component === "x" ? x : intent.component === "y" ? y : intent.component === "z" ? z : norm;
    scalarValues[i] = value;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  const segments = !scalar && intent.vectors ? new Float32Array(count * 6) : null;
  // One global display scale preserves relative amplitudes. It depends on carrier bounds, never camera distance.
  const extent = Math.hypot(...high.map((value, axis) => value - low[axis]));
  if (segments && maximumNorm > 0 && !(extent > 0)) throw new Error("Vector display needs a non-degenerate physical sample extent.");
  const glyphLength = extent / Math.max(4, Math.cbrt(count)) * 0.45;
  const scale = maximumNorm > 0 ? glyphLength / maximumNorm : 0;
  if (segments) for (let i = 0; i < count; i += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const start = positions[i * 3 + axis];
      const end = start + fieldView.getFloat64((i * 3 + axis) * 8, true) * scale;
      if (!Number.isFinite(Math.fround(end))) throw new Error("Antenna glyph endpoint cannot be represented.");
      segments[i * 6 + axis] = start;
      segments[i * 6 + axis + 3] = end;
    }
  }
  const boundary = intent.quantity === "device_potential" ? topologyPayload ? deviceBoundary(positionPayload, topologyPayload, count) : null : null;
  if (intent.quantity === "device_potential" && !boundary) throw new Error("Raw V requires its retained device topology, not primitive geometry.");
  return { key: JSON.stringify(intent), positions, scalarValues, vectorSegments: segments, surfaceTriangles: boundary?.triangles ?? null, surfaceEdges: boundary?.edges ?? null, minimum, maximum, count, intent };
}
