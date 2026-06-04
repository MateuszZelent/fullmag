import { describe, expect, it } from "vitest";

import { decodeTableRows } from "./tableRowsCodec";

function makePayload(
  values: readonly number[],
  { flags = 0 }: { flags?: number } = {},
): ArrayBuffer {
  const buffer = new ArrayBuffer(60 + values.length * Float64Array.BYTES_PER_ELEMENT);
  const bytes = new Uint8Array(buffer);
  bytes.set([70, 77, 84, 66], 0);
  const view = new DataView(buffer);
  view.setUint16(4, 1, true);
  view.setUint16(6, flags, true);
  view.setBigUint64(8, BigInt(12), true);
  view.setBigUint64(16, BigInt(1), true);
  view.setBigUint64(24, BigInt(11), true);
  view.setBigUint64(32, BigInt(12), true);
  view.setBigUint64(40, BigInt(12), true);
  view.setBigUint64(48, BigInt(2), true);
  view.setUint32(56, 3, true);
  for (let i = 0; i < values.length; i++) {
    view.setFloat64(60 + i * 8, values[i], true);
  }
  return buffer;
}

describe("tableRowsCodec", () => {
  it("decodes row-major FMTB v1 payloads", () => {
    const decoded = decodeTableRows(
      makePayload([11, 1.1e-12, 7.1, 12, 1.2e-12, 7.2]),
    );

    expect(decoded.revision).toBe(12);
    expect(decoded.schemaRevision).toBe(1);
    expect(decoded.cursorStart).toBe(11);
    expect(decoded.cursorEnd).toBe(12);
    expect(decoded.resyncRequired).toBe(false);
    expect(decoded.totalRows).toBe(12);
    expect(decoded.rowCount).toBe(2);
    expect(decoded.columnCount).toBe(3);
    expect(Array.from(decoded.values)).toEqual([
      11,
      1.1e-12,
      7.1,
      12,
      1.2e-12,
      7.2,
    ]);
  });

  it("decodes the resync-required flag", () => {
    const decoded = decodeTableRows(
      makePayload([11, 1.1e-12, 7.1, 12, 1.2e-12, 7.2], { flags: 1 }),
    );

    expect(decoded.resyncRequired).toBe(true);
  });

  it("rejects malformed payloads", () => {
    expect(() => decodeTableRows(new ArrayBuffer(8))).toThrow(/too short/);

    const wrongMagic = makePayload([]);
    new Uint8Array(wrongMagic)[0] = 0;
    expect(() => decodeTableRows(wrongMagic)).toThrow(/Invalid FMTB magic/);

    const truncated = makePayload([1, 2, 3]).slice(0, 64);
    expect(() => decodeTableRows(truncated)).toThrow(/size mismatch/);
  });
});
