import type { components } from "./generated/openapi-v2-types";
export type SavedPlaybackResource = components["schemas"]["SavedPlaybackResource"];

/** Decode the source-owned little-endian AoS xyz payload; never reinterpret a malformed frame. */
export function decodeSavedPlaybackFrame(buffer: ArrayBuffer, cells: number): Float64Array {
  if (!Number.isSafeInteger(cells) || cells <= 0 || cells > Math.floor(64 * 1024 * 1024 / 24)
      || buffer.byteLength !== cells * 24) throw new Error("Saved frame size differs from its grid.");
  const data = new Float64Array(cells * 3);
  const view = new DataView(buffer);
  for (let i = 0; i < data.length; i++) {
    const value = view.getFloat64(i * 8, true);
    if (!Number.isFinite(value)) throw new Error("Saved frame contains non-finite values.");
    data[i] = value;
  }
  return data;
}
