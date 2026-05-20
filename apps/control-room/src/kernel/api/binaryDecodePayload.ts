import {
  decodeFieldVector,
  decodeMeshQualityData,
  decodeTopology,
  type DecodedFieldVector,
  type DecodedMeshQualityData,
  type DecodedTopology,
} from "./codecs";

export type BinaryDecoderKind = "field-vector" | "mesh-quality-data" | "topology";

export type BinaryDecodedPayload =
  | DecodedFieldVector
  | DecodedMeshQualityData
  | DecodedTopology;

export function decodeBinaryPayload(
  kind: BinaryDecoderKind,
  buffer: ArrayBuffer,
): BinaryDecodedPayload {
  switch (kind) {
    case "field-vector":
      return decodeFieldVector(buffer);
    case "mesh-quality-data":
      return decodeMeshQualityData(buffer);
    case "topology":
      return decodeTopology(buffer);
  }
}

export function transferablesForDecodedPayload(
  payload: BinaryDecodedPayload,
): Transferable[] {
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
