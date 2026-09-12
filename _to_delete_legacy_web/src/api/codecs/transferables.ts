import type { DecodedFieldVector, DecodedTopology } from "./types";

export function arrayBufferTransferList(buffer: ArrayBuffer): Transferable[] {
  return buffer.byteLength > 0 ? [buffer] : [];
}

export function decodedPayloadTransferList(
  payload: DecodedFieldVector | DecodedTopology,
): Transferable[] {
  const transferables: Transferable[] = [];
  const seen = new Set<ArrayBuffer>();

  const add = (view: ArrayBufferView): void => {
    const buffer = view.buffer;
    if (!(buffer instanceof ArrayBuffer)) return;
    if (buffer.byteLength === 0 || seen.has(buffer)) return;
    seen.add(buffer);
    transferables.push(buffer);
  };

  if ("values" in payload) {
    add(payload.values);
    return transferables;
  }

  add(payload.positions);
  add(payload.indices);
  add(payload.boundaryFaces);
  add(payload.elementMarkers);
  add(payload.boundaryMarkers);
  return transferables;
}
