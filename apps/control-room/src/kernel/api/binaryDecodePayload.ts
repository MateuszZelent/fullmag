import { decodeCrossSection } from "./codecs/crossSectionCodec";
import { decodeCrossSectionQuality } from "./codecs/crossSectionQualityCodec";
import { decodeFieldVector } from "./codecs/fieldVectorCodec";
import { decodeMeshQualityData } from "./codecs/meshQualityDataCodec";
import { decodePeriodicPairs } from "./codecs/periodicPairsCodec";
import { decodeTableRows } from "./codecs/tableRowsCodec";
import { decodeTopology } from "./codecs/topologyCodec";
import type {
  DecodedCrossSection,
  DecodedCrossSectionQuality,
  DecodedFieldVector,
  DecodedMeshQualityData,
  DecodedPeriodicPairs,
  DecodedTableRows,
  DecodedTopology,
} from "./codecs/types";

export type BinaryDecoderKind =
  | "cross-section"
  | "cross-section-quality"
  | "field-vector"
  | "mesh-quality-data"
  | "periodic-pairs"
  | "raw-bytes"
  | "table-rows"
  | "topology";

export type BinaryDecodedPayload =
  | ArrayBuffer
  | DecodedCrossSection
  | DecodedCrossSectionQuality
  | DecodedFieldVector
  | DecodedMeshQualityData
  | DecodedPeriodicPairs
  | DecodedTableRows
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
    case "periodic-pairs":
      return decodePeriodicPairs(buffer);
    case "raw-bytes":
      return buffer;
    case "table-rows":
      return decodeTableRows(buffer);
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
