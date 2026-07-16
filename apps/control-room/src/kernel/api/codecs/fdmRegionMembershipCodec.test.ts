import { describe, expect, it } from "vitest";

import {
  decodeFdmRegionMembership,
  FMRM_HEADER_LEN,
} from "./fdmRegionMembershipCodec";

function makeBuffer(): ArrayBuffer {
  const buffer = new ArrayBuffer(FMRM_HEADER_LEN + 4 * 4);
  const view = new DataView(buffer);
  for (const [index, value] of [..."FMRM"].entries()) {
    view.setUint8(index, value.charCodeAt(0));
  }
  view.setUint8(4, 1);
  view.setUint8(5, 1);
  view.setUint32(8, 2, true);
  view.setUint32(12, 2, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, 4, true);
  view.setUint32(24, 2, true);
  view.setUint32(FMRM_HEADER_LEN, 1, true);
  view.setUint32(FMRM_HEADER_LEN + 4, 1, true);
  view.setUint32(FMRM_HEADER_LEN + 8, 2, true);
  return buffer;
}

describe("FMRM codec", () => {
  it("decodes grid identity and numeric region IDs", () => {
    const decoded = decodeFdmRegionMembership(makeBuffer());
    expect(decoded.counts).toEqual([2, 2, 1]);
    expect(decoded.cellCount).toBe(4);
    expect(decoded.legendCount).toBe(2);
    expect([...decoded.regionIds]).toEqual([1, 1, 2, 0]);
    expect(decoded.gridFingerprint).toBe("0".repeat(64));
  });

  it("rejects malformed payload lengths", () => {
    expect(() => decodeFdmRegionMembership(makeBuffer().slice(0, 65))).toThrow(
      /cell count mismatch|buffer size mismatch/,
    );
  });
});
