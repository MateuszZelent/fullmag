import { describe, expect, it } from "vitest";

import { decodeFieldVector } from "./fieldVectorCodec";

function makeFieldVectorBuffer(): ArrayBuffer {
  const buffer = new ArrayBuffer(48 + 3 * Float64Array.BYTES_PER_ELEMENT);
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMVP"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint8(4, 2);
  view.setUint8(5, 1);
  view.setUint8(6, 3);
  view.setUint32(12, 3, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, 1, true);
  new TextEncoder().encodeInto("m", new Uint8Array(buffer, 28, 16));
  new Float64Array(buffer, 48).set([1, 0, -1]);
  return buffer;
}

describe("decodeFieldVector", () => {
  it("decodes valid FMVP field vector buffers", () => {
    const decoded = decodeFieldVector(makeFieldVectorBuffer());

    expect(decoded.quantityId).toBe("m");
    expect(decoded.nComp).toBe(3);
    expect(decoded.grid).toEqual([1, 1, 1]);
    expect(Array.from(decoded.values)).toEqual([1, 0, -1]);
  });

  it("rejects malformed FMVP buffers", () => {
    const buffer = makeFieldVectorBuffer();
    new DataView(buffer).setUint8(0, "X".charCodeAt(0));

    expect(() => decodeFieldVector(buffer)).toThrow(/Invalid FMVP magic/);
  });

  it("rejects invalid FMVP component counts", () => {
    const buffer = makeFieldVectorBuffer();
    new DataView(buffer).setUint8(6, 0);

    expect(() => decodeFieldVector(buffer)).toThrow(/Unsupported FMVP component count/);
  });
});
