import { describe, expect, it } from "vitest";

import { decodeFdmPlanarGridOverlay } from "./fdmPlanarGridOverlayCodec";

describe("FMFG v1 FDM planar grid overlay", () => {
  it("decodes physical frame segments without truncation", () => {
    const decoded = decodeFdmPlanarGridOverlay(makeFmfg([[0, 0, 1, 0], [1, 0, 1, 1]]));
    expect(decoded.codec).toBe("fmfg.v1");
    expect(decoded.boundaryClassification).toBe("unavailable");
    expect(decoded.bounds).toEqual([0, 2, -1, 1]);
    expect([...decoded.segments]).toEqual([0, 0, 1, 0, 1, 0, 1, 1]);
    expect(decoded.segmentCount).toBe(2);
  });

  it("fails closed for wrong magic, version, truncation and segment budget", () => {
    const valid = makeFmfg([[0, 0, 1, 0], [1, 0, 1, 1]]);
    const wrongMagic = valid.slice(0);
    new Uint8Array(wrongMagic)[0] = "X".charCodeAt(0);
    expect(() => decodeFdmPlanarGridOverlay(wrongMagic)).toThrow(/FMFG magic/);
    const wrongVersion = valid.slice(0);
    new DataView(wrongVersion).setUint32(4, 2, true);
    expect(() => decodeFdmPlanarGridOverlay(wrongVersion)).toThrow(/FMFG version/);
    expect(() => decodeFdmPlanarGridOverlay(valid.slice(0, -1))).toThrow(/size mismatch/);
    expect(() => decodeFdmPlanarGridOverlay(valid, 1)).toThrow(/segment budget/);
  });

  it("rejects non-finite frame metadata and segment coordinates", () => {
    const badBounds = makeFmfg([[0, 0, 1, 0]]);
    new DataView(badBounds).setFloat64(32, Number.NaN, true);
    expect(() => decodeFdmPlanarGridOverlay(badBounds)).toThrow(/non-finite bounds/);
    const badSegment = makeFmfg([[0, 0, 1, 0]]);
    new DataView(badSegment).setFloat32(160, Number.POSITIVE_INFINITY, true);
    expect(() => decodeFdmPlanarGridOverlay(badSegment)).toThrow(/non-finite segment/);
  });
});

function makeFmfg(segments: number[][]): ArrayBuffer {
  const buffer = new ArrayBuffer(160 + segments.length * 16);
  const view = new DataView(buffer);
  [..."FMFG"].forEach((value, index) => view.setUint8(index, value.charCodeAt(0)));
  view.setUint32(4, 1, true);
  view.setUint32(8, segments.length, true);
  [0, 2, -1, 1].forEach((value, index) => view.setFloat64(32 + index * 8, value, true));
  [10, 20, 30, 1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((value, index) =>
    view.setFloat64(64 + index * 8, value, true));
  segments.flat().forEach((value, index) => view.setFloat32(160 + index * 4, value, true));
  return buffer;
}
