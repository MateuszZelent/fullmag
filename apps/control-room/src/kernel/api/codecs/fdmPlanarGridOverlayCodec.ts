import type { PlanarMeshOverlay } from "./crossSectionCodec";

const FMFG_HEADER_LENGTH = 160;
const MAX_FMFG_SEGMENTS = 200_000;

export function decodeFdmPlanarGridOverlay(
  buffer: ArrayBuffer,
  segmentBudget = MAX_FMFG_SEGMENTS,
): PlanarMeshOverlay {
  if (buffer.byteLength < FMFG_HEADER_LENGTH) throw new Error("FMFG header is truncated");
  const view = new DataView(buffer);
  const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
  if (magic !== "FMFG") throw new Error(`Invalid FMFG magic: ${magic}`);
  const version = view.getUint32(4, true);
  if (version !== 1) throw new Error(`Unsupported FMFG version: ${version}`);
  const segmentCount = view.getUint32(8, true);
  if (segmentCount > segmentBudget || segmentCount > MAX_FMFG_SEGMENTS) {
    throw new Error(`FMFG segment budget exceeded: ${segmentCount}`);
  }
  const expectedLength = FMFG_HEADER_LENGTH + segmentCount * 4 * Float32Array.BYTES_PER_ELEMENT;
  if (buffer.byteLength !== expectedLength) {
    throw new Error(`FMFG size mismatch: expected ${expectedLength}, got ${buffer.byteLength}`);
  }
  const bounds = readFiniteVector(view, 32, 4, "bounds");
  const origin = readFiniteVector(view, 64, 3, "origin");
  const uAxis = readFiniteVector(view, 88, 3, "u axis");
  const vAxis = readFiniteVector(view, 112, 3, "v axis");
  const normal = readFiniteVector(view, 136, 3, "normal");
  const segments = new Float32Array(buffer, FMFG_HEADER_LENGTH, segmentCount * 4);
  for (const value of segments) {
    if (!Number.isFinite(value)) {
      throw new Error("FMFG contains non-finite segment coordinates");
    }
  }
  return {
    boundaryClassification: "unavailable",
    bounds,
    codec: "fmfg.v1",
    frame: { normal, origin, uAxis, vAxis },
    segmentCount,
    segmentKinds: new Uint8Array(segmentCount).fill(2),
    segments,
    truncated: false,
  };
}

function readFiniteVector(view: DataView, offset: number, count: number, label: string): number[] {
  const values = Array.from({ length: count }, (_, index) =>
    view.getFloat64(offset + index * Float64Array.BYTES_PER_ELEMENT, true));
  if (values.some((value) => !Number.isFinite(value))) throw new Error(`FMFG has non-finite ${label}`);
  return values;
}
