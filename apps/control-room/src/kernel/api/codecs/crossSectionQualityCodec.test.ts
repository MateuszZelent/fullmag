import { describe, expect, it } from "vitest";

import {
  decodeCrossSectionQuality,
  FMQS_HEADER_LEN,
} from "./crossSectionQualityCodec";

function makeCrossSectionQualityBuffer(): ArrayBuffer {
  const buffer = new ArrayBuffer(
    FMQS_HEADER_LEN + 2 * Float32Array.BYTES_PER_ELEMENT,
  );
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMQS"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint32(4, 1, true);
  view.setUint32(8, 2, true);
  view.setFloat32(12, 0.1, true);
  view.setFloat32(16, 0.7, true);
  new Float32Array(buffer, FMQS_HEADER_LEN, 2).set([0.1, 0.7]);
  return buffer;
}

describe("crossSectionQualityCodec", () => {
  it("decodes FMQS cross-section quality values and range", () => {
    const decoded = decodeCrossSectionQuality(makeCrossSectionQualityBuffer());

    expect(decoded.perElementQuality[0]).toBeCloseTo(0.1);
    expect(decoded.perElementQuality[1]).toBeCloseTo(0.7);
    expect(decoded.range.min).toBeCloseTo(0.1);
    expect(decoded.range.max).toBeCloseTo(0.7);
  });

  it("rejects buffers with inconsistent value counts", () => {
    const buffer = makeCrossSectionQualityBuffer();
    new DataView(buffer).setUint32(8, 3, true);

    expect(() => decodeCrossSectionQuality(buffer)).toThrow(/size mismatch/);
  });
});
