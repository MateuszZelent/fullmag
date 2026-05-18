import type { DecodedMeshQualityData } from "./types";

const HEADER_LEN = 32;
const KIND_F64 = 1;
const MAGIC = "FMMQ";
const SUPPORTED_FLAGS = 0b111;
const SUPPORTED_VERSION = 1;
const FLAG_SICN = 0b001;
const FLAG_GAMMA = 0b010;
const FLAG_VOLUME = 0b100;

function readMagic(view: DataView): string {
  return String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
}

function metricCount(flags: number): number {
  return Number(Boolean(flags & FLAG_SICN)) +
    Number(Boolean(flags & FLAG_GAMMA)) +
    Number(Boolean(flags & FLAG_VOLUME));
}

function readMetric(
  buffer: ArrayBuffer,
  offset: number,
  elementCount: number,
  enabled: boolean,
): { nextOffset: number; values: Float64Array | null } {
  if (!enabled) return { nextOffset: offset, values: null };
  const values = new Float64Array(buffer, offset, elementCount);
  return {
    nextOffset: offset + values.byteLength,
    values,
  };
}

function validateFinite(metric: string, values: Float64Array | null): void {
  if (!values) return;
  for (let index = 0; index < values.length; index++) {
    if (!Number.isFinite(values[index])) {
      throw new Error(`FMMQ: non-finite ${metric} value at element ${index}`);
    }
  }
}

export function decodeMeshQualityData(buffer: ArrayBuffer): DecodedMeshQualityData {
  if (buffer.byteLength < HEADER_LEN) {
    throw new Error(
      `FMMQ buffer too short: ${buffer.byteLength} bytes, need at least ${HEADER_LEN}`,
    );
  }

  const view = new DataView(buffer);
  const magic = readMagic(view);
  if (magic !== MAGIC) {
    throw new Error(`Invalid FMMQ magic: expected "${MAGIC}", got "${magic}"`);
  }

  const version = view.getUint8(4);
  if (version !== SUPPORTED_VERSION) {
    throw new Error(
      `Unsupported FMMQ version: expected ${SUPPORTED_VERSION}, got ${version}`,
    );
  }

  const kind = view.getUint8(5);
  if (kind !== KIND_F64) {
    throw new Error(`Unsupported FMMQ payload kind: expected ${KIND_F64}, got ${kind}`);
  }

  const elementCount = view.getUint32(8, true);
  const flags = view.getUint32(12, true);
  if ((flags & ~SUPPORTED_FLAGS) !== 0) {
    throw new Error(`Unsupported FMMQ metric flags: ${flags}`);
  }
  const expected = HEADER_LEN +
    elementCount * metricCount(flags) * Float64Array.BYTES_PER_ELEMENT;
  if (buffer.byteLength !== expected) {
    throw new Error(
      `FMMQ buffer size mismatch: expected ${expected}, got ${buffer.byteLength}`,
    );
  }

  let offset = HEADER_LEN;
  const sicn = readMetric(buffer, offset, elementCount, Boolean(flags & FLAG_SICN));
  offset = sicn.nextOffset;
  const gamma = readMetric(buffer, offset, elementCount, Boolean(flags & FLAG_GAMMA));
  offset = gamma.nextOffset;
  const volume = readMetric(buffer, offset, elementCount, Boolean(flags & FLAG_VOLUME));
  offset = volume.nextOffset;
  if (offset !== buffer.byteLength) {
    throw new Error("FMMQ buffer has trailing bytes");
  }

  validateFinite("sicn", sicn.values);
  validateFinite("gamma", gamma.values);
  validateFinite("volume", volume.values);

  return {
    elementCount,
    gamma: gamma.values,
    sicn: sicn.values,
    volume: volume.values,
  };
}
