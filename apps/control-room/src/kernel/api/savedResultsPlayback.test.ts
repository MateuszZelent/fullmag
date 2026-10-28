import { describe, expect, it } from "vitest";
import { decodeSavedPlaybackFrame } from "./savedResultsPlayback";
describe("saved frame binary decoding", () => {
  it("preserves xyz components including a final cell", () => {
    const buffer = new ArrayBuffer(48); const view = new DataView(buffer);
    [1,2,3,-4,5,6].forEach((v,i) => view.setFloat64(i*8,v,true));
    expect([...decodeSavedPlaybackFrame(buffer,2)]).toEqual([1,2,3,-4,5,6]);
  });
  it("rejects partial chunks, nonfinite values and oversized grids", () => {
    expect(() => decodeSavedPlaybackFrame(new ArrayBuffer(16),1)).toThrow();
    const b = new ArrayBuffer(24); new DataView(b).setFloat64(8,NaN,true);
    expect(() => decodeSavedPlaybackFrame(b,1)).toThrow();
    expect(() => decodeSavedPlaybackFrame(new ArrayBuffer(0),1e9)).toThrow();
  });
});
