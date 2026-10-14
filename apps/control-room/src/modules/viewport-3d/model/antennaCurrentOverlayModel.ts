import type { AntennaFieldIntent } from "@/kernel/visualization/antennaFieldIntent";
import { antennaDisplayShape, buildAntennaFieldOverlayModel, deviceBoundary, MAX_ANTENNA_DISPLAY_CELLS, MAX_ANTENNA_DISPLAY_PAYLOAD_BYTES, type AntennaDisplayDescriptor, type AntennaFieldOverlayModel } from "./antennaFieldOverlayModel";

export function antennaCurrentTraceShape(
  centerPositions: AntennaDisplayDescriptor, centerValues: AntennaDisplayDescriptor,
  tracePositions: AntennaDisplayDescriptor, traceValues: AntennaDisplayDescriptor,
  devicePositions: AntennaDisplayDescriptor, topology: AntennaDisplayDescriptor,
  intent: AntennaFieldIntent,
): number {
  const count = antennaDisplayShape(centerPositions, centerValues, intent);
  const descriptors = [centerPositions, centerValues, tracePositions, traceValues, devicePositions, topology];
  if (intent.kind !== "inspection" || intent.quantity !== "current_density" || count > MAX_ANTENNA_DISPLAY_CELLS ||
      tracePositions.scalar_type !== "float64_le" || tracePositions.layout !== "cell_local_vertex_xyz_interleaved" || tracePositions.unit !== "m" ||
      traceValues.scalar_type !== "float64_le" || traceValues.layout !== "cell_local_vertex_vector_xyz_interleaved" || traceValues.unit !== "A/m^2" ||
      tracePositions.value_count !== count * 12 || traceValues.value_count !== count * 12 ||
      devicePositions.scalar_type !== "float64_le" || devicePositions.layout !== "node_xyz_interleaved" || devicePositions.unit !== "m" ||
      !Number.isSafeInteger(devicePositions.value_count / 3) || devicePositions.value_count <= 0 ||
      devicePositions.value_count / 3 > count * 4 ||
      topology.scalar_type !== "uint32_le" || topology.layout !== "tet4_connectivity" || topology.unit !== "1" || topology.value_count !== count * 4 ||
      descriptors.some((value) => !/^[a-f0-9]{64}$/i.test(value.sha256) || value.byte_count !== value.value_count * (value.scalar_type === "uint32_le" ? 4 : 8)) ||
      descriptors.reduce((sum, value) => sum + (value.byte_count ?? Infinity), 0) > MAX_ANTENNA_DISPLAY_PAYLOAD_BYTES) {
    throw new Error("Antenna J requires a complete bounded device Tet4 carrier, owned centers and cell-local vector traces in SI; no nodal averaging.");
  }
  return count;
}

/** Surface vertices retain their cell owner. No current reconstruction or shared-node average. */
export function buildAntennaCurrentOverlayModel(
  centerPositions: ArrayBuffer, centerValues: ArrayBuffer, tracePositions: ArrayBuffer, traceValues: ArrayBuffer,
  devicePositions: ArrayBuffer, topology: ArrayBuffer, count: number, intent: AntennaFieldIntent,
): AntennaFieldOverlayModel {
  if (intent.kind !== "inspection" || intent.quantity !== "current_density" ||
      tracePositions.byteLength !== count * 96 || traceValues.byteLength !== count * 96 ||
      devicePositions.byteLength === 0 || devicePositions.byteLength % 24 !== 0 || topology.byteLength !== count * 16 ||
      [centerPositions, centerValues, tracePositions, traceValues, devicePositions, topology].reduce((sum, value) => sum + value.byteLength, 0) > MAX_ANTENNA_DISPLAY_PAYLOAD_BYTES) {
    throw new Error("Antenna J payloads differ from the complete pinned carrier.");
  }
  const model = buildAntennaFieldOverlayModel(centerPositions, centerValues, count, { ...intent, vectors: false });
  const nodeCount = devicePositions.byteLength / 24;
  const device = new DataView(devicePositions), traces = new DataView(tracePositions), values = new DataView(traceValues), cells = new DataView(topology);
  const wirePositions = new Float32Array(nodeCount * 3);
  const surfacePositions = new Float32Array(count * 12), surfaceVectorValues = new Float32Array(count * 12);
  const lower = [Infinity, Infinity, Infinity], upper = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < nodeCount * 3; index++) {
    const value = device.getFloat64(index * 8, true);
    if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) throw new Error("Non-finite device coordinate.");
    wirePositions[index] = value;
    lower[index % 3] = Math.min(lower[index % 3], value);
    upper[index % 3] = Math.max(upper[index % 3], value);
  }
  const boundary = deviceBoundary(devicePositions, topology, nodeCount);
  let minimum = model.minimum, maximum = model.maximum, maximumNorm = 0;
  const center = new DataView(centerValues);
  for (let cell = 0; cell < count; cell++) maximumNorm = Math.max(maximumNorm, Math.hypot(...[0, 1, 2].map((axis) => center.getFloat64((cell * 3 + axis) * 8, true))));
  for (let vertex = 0; vertex < count * 4; vertex++) {
    const node = cells.getUint32(vertex * 4, true);
    const vector = [0, 1, 2].map((axis) => {
      const index = vertex * 3 + axis, coordinate = traces.getFloat64(index * 8, true);
      if (coordinate !== device.getFloat64((node * 3 + axis) * 8, true)) throw new Error("Cell-local J trace position differs from retained device topology.");
      surfacePositions[index] = coordinate;
      return values.getFloat64(index * 8, true);
    });
    const norm = Math.hypot(...vector);
    if (!vector.every(Number.isFinite) || !Number.isFinite(norm)) throw new Error("Non-finite cell-local J trace.");
    maximumNorm = Math.max(maximumNorm, norm);
    const scalar = intent.component === "x" ? vector[0] : intent.component === "y" ? vector[1] : intent.component === "z" ? vector[2] : norm;
    minimum = Math.min(minimum, scalar); maximum = Math.max(maximum, scalar);
  }
  // |affine J| may vanish between nonzero vertices; never interpolate vertex norms.
  if (intent.component === "magnitude") minimum = 0;
  const surfaceVectorScale = maximumNorm || 1;
  for (let index = 0; index < surfaceVectorValues.length; index++) surfaceVectorValues[index] = values.getFloat64(index * 8, true) / surfaceVectorScale;
  const vectorSegments = intent.vectors ? new Float32Array(count * 6) : null;
  const extent = Math.hypot(...upper.map((value, axis) => value - lower[axis]));
  const glyphLength = extent / Math.max(4, Math.cbrt(count)) * 0.45;
  if (vectorSegments) for (let cell = 0; cell < count; cell++) for (let axis = 0; axis < 3; axis++) {
    const start = model.positions[cell * 3 + axis];
    const end = start + center.getFloat64((cell * 3 + axis) * 8, true) / surfaceVectorScale * glyphLength;
    if (!Number.isFinite(Math.fround(end))) throw new Error("J glyph endpoint cannot be represented.");
    vectorSegments[cell * 6 + axis] = start; vectorSegments[cell * 6 + axis + 3] = end;
  }
  return { ...model, key: JSON.stringify(intent), intent, minimum, maximum, vectorSegments,
    surfacePositions, surfaceVectorValues, surfaceVectorScale, wirePositions,
    surfaceTriangles: boundary.localTriangles, surfaceEdges: boundary.edges };
}

/** Reproject only field scalars; preserve the immutable carrier and full-vector glyphs. */
export function projectAntennaCurrentOverlayModel(model: AntennaFieldOverlayModel, centerValues: ArrayBuffer, traceValues: ArrayBuffer, intent: AntennaFieldIntent): AntennaFieldOverlayModel {
  if (intent.kind !== "inspection" || intent.quantity !== "current_density") throw new Error("J projection requires a raw current intent.");
  if (intent.component === model.intent.component) return { ...model, key: JSON.stringify(intent), intent };
  const centers = new DataView(centerValues), traces = new DataView(traceValues);
  const scalarValues = new Float64Array(model.count);
  let minimum = Infinity, maximum = -Infinity;
  for (const [values, count] of [[centers, model.count], [traces, model.count * 4]] as const) {
    for (let index = 0; index < count; index++) {
      const scalar = intent.component === "x" ? values.getFloat64(index * 24, true) : intent.component === "y" ? values.getFloat64(index * 24 + 8, true) : intent.component === "z" ? values.getFloat64(index * 24 + 16, true) : Math.hypot(values.getFloat64(index * 24, true), values.getFloat64(index * 24 + 8, true), values.getFloat64(index * 24 + 16, true));
      if (values === centers) scalarValues[index] = scalar;
      minimum = Math.min(minimum, scalar); maximum = Math.max(maximum, scalar);
    }
  }
  if (intent.component === "magnitude") minimum = 0;
  return { ...model, key: JSON.stringify(intent), intent, scalarValues, minimum, maximum };
}
