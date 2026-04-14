/* ── Binary preview frame decoder ──
 * Handles the FMVP binary websocket protocol for vector field payloads.
 *
 * NOTE: Currently unused after the WS→HTTP polling migration.
 * Retained for potential future binary transport (e.g. chunked HTTP, SSE). */

import type { SessionState } from "./types";

interface PreviewBinaryPayload {
  payloadId: number;
  vectorFieldValues: Float64Array;
}

const PREVIEW_BINARY_FRAME_MAGIC = "FMVP";
const PREVIEW_BINARY_FRAME_HEADER_LEN = 16;
const PREVIEW_BINARY_FRAME_V2_HEADER_LEN = 48;
const PREVIEW_BINARY_FRAME_KIND_F64 = 1;

/** Decoded V2 binary frame with quantity metadata. */
export interface PreviewBinaryPayloadV2 extends PreviewBinaryPayload {
  version: 2;
  quantityId: string;
  nComp: number;
  grid: [number, number, number];
}

export function decodePreviewBinaryFrame(
  data: ArrayBuffer,
): PreviewBinaryPayload | PreviewBinaryPayloadV2 | null {
  if (data.byteLength < PREVIEW_BINARY_FRAME_HEADER_LEN) {
    return null;
  }

  const view = new DataView(data);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (magic !== PREVIEW_BINARY_FRAME_MAGIC) {
    return null;
  }

  const version = view.getUint8(4);
  const kind = view.getUint8(5);
  if (kind !== PREVIEW_BINARY_FRAME_KIND_F64) {
    return null;
  }

  if (version === 2) {
    return decodePreviewBinaryFrameV2(data, view);
  }
  if (version !== 1) {
    return null;
  }

  const payloadId = view.getUint32(8, true);
  const elementCount = view.getUint32(12, true);
  const expectedLength = PREVIEW_BINARY_FRAME_HEADER_LEN + elementCount * 8;
  if (data.byteLength !== expectedLength) {
    return null;
  }

  return {
    payloadId,
    vectorFieldValues: new Float64Array(data, PREVIEW_BINARY_FRAME_HEADER_LEN, elementCount),
  };
}

function decodePreviewBinaryFrameV2(
  data: ArrayBuffer,
  view: DataView,
): PreviewBinaryPayloadV2 | null {
  if (data.byteLength < PREVIEW_BINARY_FRAME_V2_HEADER_LEN) {
    return null;
  }
  const nComp = view.getUint8(6);
  const payloadId = view.getUint32(8, true);
  const elementCount = view.getUint32(12, true);
  const gridX = view.getUint32(16, true);
  const gridY = view.getUint32(20, true);
  const gridZ = view.getUint32(24, true);
  // quantity_id: 16 bytes null-padded at offset 28
  const idBytes = new Uint8Array(data, 28, 16);
  let idEnd = idBytes.indexOf(0);
  if (idEnd === -1) idEnd = 16;
  const quantityId = new TextDecoder().decode(idBytes.subarray(0, idEnd));
  const expectedLength = PREVIEW_BINARY_FRAME_V2_HEADER_LEN + elementCount * 8;
  if (data.byteLength !== expectedLength) {
    return null;
  }
  return {
    version: 2,
    payloadId,
    quantityId,
    nComp,
    grid: [gridX, gridY, gridZ],
    vectorFieldValues: new Float64Array(data, PREVIEW_BINARY_FRAME_V2_HEADER_LEN, elementCount),
  };
}

export function attachPreviewBinaryPayload(
  prev: SessionState | null,
  payloadId: number,
  vectorFieldValues: Float64Array,
  v2Meta?: { quantityId: string; nComp: number; grid: [number, number, number] },
): SessionState | null {
  if (!prev || !prev.preview || prev.preview.kind !== "spatial") {
    return prev;
  }
  if (prev.preview.vector_payload_id !== payloadId) {
    return prev;
  }
  if (prev.preview.vector_field_values === vectorFieldValues) {
    return prev;
  }
  return {
    ...prev,
    preview: {
      ...prev.preview,
      vector_field_values: vectorFieldValues,
      ...(v2Meta ? { n_comp: v2Meta.nComp, preview_grid: v2Meta.grid } : {}),
    },
  };
}
