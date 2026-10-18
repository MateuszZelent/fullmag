import type { AntennaFieldIntent } from "@/kernel/visualization/antennaFieldIntent";
import { MAX_ANTENNA_DISPLAY_CELLS, MAX_ANTENNA_DISPLAY_SAMPLES, MAX_ANTENNA_DISPLAY_PAYLOAD_BYTES, buildAntennaFieldOverlayModel, deviceBoundary } from "./antennaFieldOverlayModel";
import { buildAntennaCurrentOverlayModel } from "./antennaCurrentOverlayModel";

/** Decode stable u64 identities without converting them to lossy JavaScript numbers. */
export function decodeClosedLoopTet4(idsPayload: ArrayBuffer, vertexPayload: ArrayBuffer, cellsPayload: ArrayBuffer, nodeCount: number, cellCount: number) {
  if (!Number.isSafeInteger(nodeCount) || nodeCount < 1 || nodeCount > MAX_ANTENNA_DISPLAY_SAMPLES || !Number.isSafeInteger(cellCount) || cellCount < 1 || cellCount > MAX_ANTENNA_DISPLAY_CELLS ||
      idsPayload.byteLength !== nodeCount * 8 || vertexPayload.byteLength !== nodeCount * 24 || cellsPayload.byteLength !== cellCount * 280 ||
      idsPayload.byteLength + vertexPayload.byteLength + cellsPayload.byteLength + cellCount * 256 > MAX_ANTENNA_DISPLAY_PAYLOAD_BYTES) throw new Error("Closed-loop Tet4 carrier exceeds its complete display bound.");
  const ids = new DataView(idsPayload), vertices = new DataView(vertexPayload), cells = new DataView(cellsPayload);
  const indices = new Map<bigint, number>(), ordinals = new Set<bigint>();
  for (let node = 0; node < nodeCount; node++) {
    const id = ids.getBigUint64(node * 8, true);
    if (indices.has(id)) throw new Error("Duplicate closed-loop stable vertex identity.");
    indices.set(id, node);
    for (let axis = 0; axis < 3; axis++) if (!Number.isFinite(vertices.getFloat64((node * 3 + axis) * 8, true))) throw new Error("Non-finite closed-loop vertex coordinate.");
  }
  const topology = new ArrayBuffer(cellCount * 16), traces = new ArrayBuffer(cellCount * 96), localCurrent = new ArrayBuffer(cellCount * 96), centers = new ArrayBuffer(cellCount * 24), centerCurrent = new ArrayBuffer(cellCount * 24);
  const topologyView = new DataView(topology), traceView = new DataView(traces), localView = new DataView(localCurrent), centerView = new DataView(centers), currentView = new DataView(centerCurrent);
  for (let cell = 0; cell < cellCount; cell++) {
    const offset = cell * 280, ordinal = cells.getBigUint64(offset, true);
    if (ordinals.has(ordinal)) throw new Error("Duplicate closed-loop source element identity.");
    ordinals.add(ordinal);
    for (let vertex = 0; vertex < 4; vertex++) {
      const node = indices.get(cells.getBigUint64(offset + 8 + vertex * 8, true));
      if (node === undefined) throw new Error("Closed-loop cell references an absent stable vertex identity.");
      topologyView.setUint32((cell * 4 + vertex) * 4, node, true);
      for (let axis = 0; axis < 3; axis++) {
        const position = cells.getFloat64(offset + 40 + (vertex * 3 + axis) * 8, true), current = cells.getFloat64(offset + 136 + (vertex * 3 + axis) * 8, true);
        if (!Number.isFinite(current) || position !== vertices.getFloat64((node * 3 + axis) * 8, true)) throw new Error("Closed-loop cell geometry or local current differs from its owned carrier.");
        traceView.setFloat64((cell * 12 + vertex * 3 + axis) * 8, position, true);
        localView.setFloat64((cell * 12 + vertex * 3 + axis) * 8, current, true);
      }
    }
    for (let axis = 0; axis < 3; axis++) {
      const position = cells.getFloat64(offset + 232 + axis * 8, true), current = cells.getFloat64(offset + 256 + axis * 8, true);
      const quarterSum = [0, 1, 2, 3].reduce((sum, vertex) => sum + cells.getFloat64(offset + 40 + (vertex * 3 + axis) * 8, true) / 4, 0);
      if (!Number.isFinite(position) || !Number.isFinite(current) || Math.abs(position - quarterSum) > 16 * Number.EPSILON * Math.max(Math.abs(position), ...[0, 1, 2, 3].map((vertex) => Math.abs(cells.getFloat64(offset + 40 + (vertex * 3 + axis) * 8, true))))) throw new Error("Closed-loop cell center is not its finite Tet4 quarter-sum carrier.");
      centerView.setFloat64((cell * 3 + axis) * 8, position, true); currentView.setFloat64((cell * 3 + axis) * 8, current, true);
    }
  }
  return { topology, traces, localCurrent, centers, centerCurrent };
}
function requireExactOwnedCurrent(actual: ArrayBuffer, retained: ArrayBuffer, scale: number) {
  if (!Number.isFinite(scale) || scale === 0) throw new Error("Invalid closed-loop current display normalization.");
  if (scale !== 1) {
    const raw = new DataView(retained), scaled = new DataView(new ArrayBuffer(retained.byteLength));
    for (let index = 0; index < retained.byteLength; index += 8) scaled.setFloat64(index, raw.getFloat64(index, true) * scale, true);
    retained = scaled.buffer;
  }
  const bytes = new Uint8Array(actual), expected = new Uint8Array(retained);
  if (actual.byteLength !== retained.byteLength || bytes.some((byte, index) => byte !== expected[index])) throw new Error("Closed-loop J differs from its retained cell-owned current.");
}
export function buildClosedLoopCurrentOverlayModel(ids: ArrayBuffer, vertices: ArrayBuffer, cells: ArrayBuffer, centerCurrent: ArrayBuffer, localCurrent: ArrayBuffer, nodeCount: number, cellCount: number, intent: AntennaFieldIntent, scale = 1) {
  const carrier = decodeClosedLoopTet4(ids, vertices, cells, nodeCount, cellCount);
  requireExactOwnedCurrent(centerCurrent, carrier.centerCurrent, scale); requireExactOwnedCurrent(localCurrent, carrier.localCurrent, scale);
  const model = buildAntennaCurrentOverlayModel(carrier.centers, centerCurrent, carrier.traces, localCurrent, vertices, carrier.topology, cellCount, { ...intent, quantity: "current_density" });
  return { ...model, key: JSON.stringify(intent), intent };
}
export function buildClosedLoopPotentialOverlayModel(ids: ArrayBuffer, vertices: ArrayBuffer, cells: ArrayBuffer, potential: ArrayBuffer, nodeCount: number, cellCount: number, intent: AntennaFieldIntent) {
  const carrier = decodeClosedLoopTet4(ids, vertices, cells, nodeCount, cellCount);
  const model = buildAntennaFieldOverlayModel(vertices, potential, nodeCount, { ...intent, quantity: "device_potential" }, carrier.topology);
  return { ...model, key: JSON.stringify(intent), intent };
}

/** H belongs to the retained sampling Tet4 mesh, independent of conductor V/J geometry. */
export function buildClosedLoopMagneticOverlayModel(positions: ArrayBuffer, field: ArrayBuffer, topology: ArrayBuffer, nodeCount: number, cellCount: number, intent: AntennaFieldIntent) {
  if (!Number.isSafeInteger(cellCount) || cellCount < 1 || cellCount > MAX_ANTENNA_DISPLAY_CELLS || topology.byteLength !== cellCount * 16 ||
      positions.byteLength + field.byteLength + topology.byteLength > MAX_ANTENNA_DISPLAY_PAYLOAD_BYTES) throw new Error("Closed-loop H sampling topology exceeds its owned display bound.");
  const model = buildAntennaFieldOverlayModel(positions, field, nodeCount, intent);
  const boundary = deviceBoundary(positions, topology, nodeCount), values = new DataView(field);
  let maximumNorm = 0;
  for (let node = 0; node < nodeCount; node++) maximumNorm = Math.max(maximumNorm, Math.hypot(...[0, 1, 2].map((axis) => values.getFloat64((node * 3 + axis) * 8, true))));
  const surfaceVectorScale = maximumNorm || 1, surfaceVectorValues = new Float32Array(nodeCount * 3);
  for (let index = 0; index < surfaceVectorValues.length; index++) surfaceVectorValues[index] = values.getFloat64(index * 8, true) / surfaceVectorScale;
  return { ...model, minimum: intent.component === "magnitude" ? 0 : model.minimum, surfaceTriangles: boundary.triangles, surfaceEdges: boundary.edges, surfaceVectorValues, surfaceVectorScale };
}
