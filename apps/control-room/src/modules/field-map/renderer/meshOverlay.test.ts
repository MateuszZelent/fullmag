import { describe, expect, it } from "vitest";

import { decodePlanarMeshOverlayForDescriptor } from "./meshOverlay";

describe("FMCS v3 planar mesh overlay", () => {
  it("maps the physical frame and reports an explicit segment cap", () => {
    const buffer = makeOverlay(2);
    const overlay = decodePlanarMeshOverlayForDescriptor(buffer, { codec: "fmcs.v3" }, 1);
    expect(overlay.bounds).toEqual([0, 2, -1, 1]);
    expect(overlay.frame).toEqual({
      normal: [0, 0, 1],
      origin: [10, 20, 30],
      uAxis: [1, 0, 0],
      vAxis: [0, 1, 0],
    });
    expect(overlay.segments).toHaveLength(4);
    expect(overlay.segmentCount).toBe(2);
    expect(overlay.truncated).toBe(true);
  });

  it("dispatches FMFG and rejects descriptor-to-magic mismatch", () => {
    const fmfg = makeFdmOverlay();
    expect(decodePlanarMeshOverlayForDescriptor(fmfg, { codec: "fmfg.v1" }).codec).toBe("fmfg.v1");
    expect(() => decodePlanarMeshOverlayForDescriptor(fmfg, { codec: "fmcs.v4" })).toThrow(/codec mismatch/);
    expect(() => decodePlanarMeshOverlayForDescriptor(makeOverlay(0), { codec: "fmfg.v1" })).toThrow(/codec mismatch/);
  });
});

function makeFdmOverlay(): ArrayBuffer {
  const buffer = new ArrayBuffer(176);
  const view = new DataView(buffer);
  [..."FMFG"].forEach((value, index) => view.setUint8(index, value.charCodeAt(0)));
  view.setUint32(4, 1, true);
  view.setUint32(8, 1, true);
  [0, 1, 0, 1].forEach((value, index) => view.setFloat64(32 + index * 8, value, true));
  [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((value, index) => view.setFloat64(64 + index * 8, value, true));
  [0, 0, 1, 0].forEach((value, index) => view.setFloat32(160 + index * 4, value, true));
  return buffer;
}

function makeOverlay(segmentCount: number): ArrayBuffer {
  const buffer = new ArrayBuffer(160 + 4 + segmentCount * 16);
  const view = new DataView(buffer);
  [..."FMCS"].forEach((value, index) =>
    view.setUint8(index, value.charCodeAt(0)),
  );
  view.setUint32(4, 3, true);
  view.setUint32(8, 0, true);
  view.setUint32(12, 0, true);
  view.setUint32(16, segmentCount, true);
  [0, 2, -1, 1].forEach((value, index) =>
    view.setFloat64(32 + index * 8, value, true),
  );
  [
    10, 20, 30,
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ].forEach((value, index) => view.setFloat64(64 + index * 8, value, true));
  view.setUint32(160, 0, true);
  return buffer;
}
