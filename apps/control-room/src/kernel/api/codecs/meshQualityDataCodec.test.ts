import { describe, expect, it } from "vitest";

import { decodeMeshQualityData } from "./meshQualityDataCodec";

function writeMagic(view: DataView, magic: string): void {
  for (const [index, code] of [...magic].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
}

function makeQualityBuffer(flags = 0b111): ArrayBuffer {
  const elementCount = 2;
  const metricCount =
    Number(Boolean(flags & 0b001)) +
    Number(Boolean(flags & 0b010)) +
    Number(Boolean(flags & 0b100));
  const buffer = new ArrayBuffer(
    32 + elementCount * metricCount * Float64Array.BYTES_PER_ELEMENT,
  );
  const view = new DataView(buffer);
  writeMagic(view, "FMMQ");
  view.setUint8(4, 1);
  view.setUint8(5, 1);
  view.setUint32(8, elementCount, true);
  view.setUint32(12, flags, true);

  let offset = 32;
  if (flags & 0b001) {
    new Float64Array(buffer, offset, elementCount).set([0.4, 0.8]);
    offset += elementCount * Float64Array.BYTES_PER_ELEMENT;
  }
  if (flags & 0b010) {
    new Float64Array(buffer, offset, elementCount).set([0.2, 0.6]);
    offset += elementCount * Float64Array.BYTES_PER_ELEMENT;
  }
  if (flags & 0b100) {
    new Float64Array(buffer, offset, elementCount).set([1.0, 2.0]);
  }
  return buffer;
}

describe("decodeMeshQualityData", () => {
  it("decodes FMMQ per-element quality arrays", () => {
    const decoded = decodeMeshQualityData(makeQualityBuffer());

    expect(decoded.elementCount).toBe(2);
    expect(Array.from(decoded.sicn ?? [])).toEqual([0.4, 0.8]);
    expect(Array.from(decoded.gamma ?? [])).toEqual([0.2, 0.6]);
    expect(Array.from(decoded.volume ?? [])).toEqual([1, 2]);
  });

  it("rejects buffers with unsupported flags", () => {
    const buffer = makeQualityBuffer(0b1000);

    expect(() => decodeMeshQualityData(buffer)).toThrow(/Unsupported FMMQ metric flags/);
  });
});
