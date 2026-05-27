import { describe, expect, it } from "vitest";

import { decodeFieldVector } from "./fieldVectorCodec";

function makeFieldVectorBuffer({
  nComp = 3,
  quantityId = "m",
  values = [1, 0, -1],
}: {
  nComp?: number;
  quantityId?: string;
  values?: number[];
} = {}): ArrayBuffer {
  const buffer = new ArrayBuffer(
    48 + values.length * Float64Array.BYTES_PER_ELEMENT,
  );
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMVP"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint8(4, 2);
  view.setUint8(5, 1);
  view.setUint8(6, nComp);
  view.setUint32(12, values.length, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, 1, true);
  new TextEncoder().encodeInto(quantityId, new Uint8Array(buffer, 28, 16));
  new Float64Array(buffer, 48).set(values);
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

  it("decodes tensor-valued FMVP quantities with more than three components", () => {
    const decoded = decodeFieldVector(
      makeFieldVectorBuffer({
        nComp: 6,
        quantityId: "stress",
        values: [1, 2, 3, 4, 5, 6],
      }),
    );

    expect(decoded.quantityId).toBe("stress");
    expect(decoded.nComp).toBe(6);
    expect(decoded.valueCount).toBe(6);
    expect(Array.from(decoded.values)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("rejects invalid FMVP component counts", () => {
    const buffer = makeFieldVectorBuffer();
    new DataView(buffer).setUint8(6, 0);

    expect(() => decodeFieldVector(buffer)).toThrow(/Unsupported FMVP component count/);
  });
});
