import {
  decodeCrossSection,
  decodeCrossSectionQuality,
  decodeFieldVector,
  decodeMeshQualityData,
  decodeTopology,
  type DecodedCrossSection,
  type DecodedCrossSectionQuality,
  type DecodedFieldVector,
  type DecodedMeshQualityData,
  type DecodedTopology,
} from "./codecs";

export type BinaryDecoderKind =
  | "cross-section"
  | "cross-section-quality"
  | "field-vector"
  | "mesh-quality-data"
  | "raw-bytes"
  | "topology";

export type BinaryDecodedPayload =
  | ArrayBuffer
  | DecodedCrossSection
  | DecodedCrossSectionQuality
  | DecodedFieldVector
  | DecodedMeshQualityData
  | DecodedTopology;

export function decodeBinaryPayload(
  kind: BinaryDecoderKind,
  buffer: ArrayBuffer,
): BinaryDecodedPayload {
  switch (kind) {
    case "cross-section":
      return decodeCrossSection(buffer);
    case "cross-section-quality":
      return decodeCrossSectionQuality(buffer);
    case "field-vector":
      return decodeFieldVector(buffer);
    case "mesh-quality-data":
      return decodeMeshQualityData(buffer);
    case "raw-bytes":
      return buffer;
    case "topology":
      return decodeTopology(buffer);
  }
}

export function transferablesForDecodedPayload(
  payload: BinaryDecodedPayload,
): Transferable[] {
  if (payload instanceof ArrayBuffer) {
    return [payload];
  }
  const buffers = new Set<ArrayBuffer>();
  for (const value of Object.values(payload)) {
    if (isTypedArrayWithTransferableBuffer(value)) {
      buffers.add(value.buffer);
    }
  }
  return [...buffers];
}

function isTypedArrayWithTransferableBuffer(
  value: unknown,
): value is { buffer: ArrayBuffer } {
  return (
    ArrayBuffer.isView(value) &&
    value.buffer instanceof ArrayBuffer &&
    !(value instanceof DataView)
  );
}
