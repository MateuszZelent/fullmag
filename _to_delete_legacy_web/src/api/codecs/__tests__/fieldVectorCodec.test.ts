import { describe, it, expect } from "vitest";
import { decodeFieldVector } from "../fieldVectorCodec";

/** Build a valid FMVP v2 buffer with the given parameters. */
function buildFmvpBuffer(opts: {
  nComp?: number;
  gridX?: number;
  gridY?: number;
  gridZ?: number;
  quantityId?: string;
  values?: number[];
}): ArrayBuffer {
  const {
    nComp = 3,
    gridX = 2,
    gridY = 2,
    gridZ = 1,
    quantityId = "m",
    values,
  } = opts;

  const elementCount = values ? values.length : gridX * gridY * gridZ * nComp;
  const payloadBytes = elementCount * 8;
  const totalBytes = 48 + payloadBytes;
  const buf = new ArrayBuffer(totalBytes);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // Magic "FMVP"
  u8[0] = 0x46; // F
  u8[1] = 0x4d; // M
  u8[2] = 0x56; // V
  u8[3] = 0x50; // P

  view.setUint8(4, 2); // version
  view.setUint8(5, 1); // kind (float64)
  view.setUint8(6, nComp);
  view.setUint8(7, 0); // reserved
  view.setUint32(8, 0, true); // payloadId
  view.setUint32(12, elementCount, true);
  view.setUint32(16, gridX, true);
  view.setUint32(20, gridY, true);
  view.setUint32(24, gridZ, true);

  // quantityId: null-padded ASCII at offset 28, 16 bytes
  const enc = new TextEncoder();
  const idBytes = enc.encode(quantityId);
  u8.set(idBytes.subarray(0, 16), 28);

  // reserved at 44
  view.setUint32(44, 0, true);

  // Payload
  const f64 = new Float64Array(buf, 48, elementCount);
  if (values) {
    f64.set(values);
  } else {
    for (let i = 0; i < elementCount; i++) f64[i] = i * 0.1;
  }

  return buf;
}

describe("decodeFieldVector (FMVP v2)", () => {
  it("decodes a valid buffer with known values", () => {
    const values = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0];
    const buf = buildFmvpBuffer({
      nComp: 3,
      gridX: 2,
      gridY: 2,
      gridZ: 1,
      quantityId: "m",
      values,
    });

    const decoded = decodeFieldVector(buf);

    expect(decoded.quantityId).toBe("m");
    expect(decoded.nComp).toBe(3);
    expect(decoded.grid).toEqual([2, 2, 1]);
    expect(decoded.pointCount).toBe(4);
    expect(decoded.valueCount).toBe(12);
    expect(decoded.dtype).toBe("float64");
    expect(decoded.values.length).toBe(12);
    expect(decoded.values[0]).toBe(1.0);
    expect(decoded.values[11]).toBe(12.0);
  });

  it("decodes a longer quantityId", () => {
    const buf = buildFmvpBuffer({
      nComp: 1,
      gridX: 1,
      gridY: 1,
      gridZ: 1,
      quantityId: "eden_exchange",
      values: [42.0],
    });
    const decoded = decodeFieldVector(buf);
    expect(decoded.quantityId).toBe("eden_exchange");
  });

  it("rejects buffer with invalid magic", () => {
    const buf = buildFmvpBuffer({ values: [1.0] });
    const u8 = new Uint8Array(buf);
    u8[0] = 0x00; // corrupt magic
    expect(() => decodeFieldVector(buf)).toThrow(/Invalid FMVP magic/);
  });

  it("rejects buffer too small for header", () => {
    const buf = new ArrayBuffer(10);
    expect(() => decodeFieldVector(buf)).toThrow(/too short/);
  });

  it("rejects buffer with mismatched payload size", () => {
    // Build valid header claiming 100 elements but provide only header
    const buf = new ArrayBuffer(48);
    const view = new DataView(buf);
    const u8 = new Uint8Array(buf);
    u8[0] = 0x46; u8[1] = 0x4d; u8[2] = 0x56; u8[3] = 0x50;
    view.setUint8(4, 2);
    view.setUint8(5, 1);
    view.setUint8(6, 3);
    view.setUint32(12, 100, true); // elementCount = 100, but no payload
    expect(() => decodeFieldVector(buf)).toThrow(/size mismatch/);
  });

  it("rejects unsupported version", () => {
    const buf = buildFmvpBuffer({ values: [1.0] });
    const view = new DataView(buf);
    view.setUint8(4, 99); // unsupported version
    expect(() => decodeFieldVector(buf)).toThrow(/Unsupported FMVP version/);
  });

  it("rejects unsupported value kind", () => {
    const buf = buildFmvpBuffer({ values: [1.0] });
    const view = new DataView(buf);
    view.setUint8(5, 42); // unsupported kind
    expect(() => decodeFieldVector(buf)).toThrow(/Unsupported FMVP value kind/);
  });
});
