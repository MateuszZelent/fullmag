import { describe, expect, it } from "vitest";

import { decodeTopology } from "./topologyCodec";

function makeTopologyBuffer(): ArrayBuffer {
  const nodeCount = 4;
  const elementCount = 1;
  const boundaryFaceCount = 1;
  const markerCount = 1;
  const byteLength =
    32 +
    nodeCount * 3 * Float64Array.BYTES_PER_ELEMENT +
    elementCount * 4 * Uint32Array.BYTES_PER_ELEMENT +
    boundaryFaceCount * 3 * Uint32Array.BYTES_PER_ELEMENT +
    markerCount * Uint32Array.BYTES_PER_ELEMENT +
    markerCount * Uint32Array.BYTES_PER_ELEMENT;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMMT"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint8(4, 1);
  view.setUint8(5, 1);
  view.setUint32(8, nodeCount, true);
  view.setUint32(12, elementCount, true);
  view.setUint32(16, boundaryFaceCount, true);
  view.setUint32(20, markerCount, true);
  view.setUint32(24, markerCount, true);

  let offset = 32;
  new Float64Array(buffer, offset, nodeCount * 3).set([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ]);
  offset += nodeCount * 3 * Float64Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, 4).set([0, 1, 2, 3]);
  offset += 4 * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, 3).set([0, 1, 2]);
  offset += 3 * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, 1).set([10]);
  offset += Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, 1).set([20]);
  return buffer;
}

describe("decodeTopology", () => {
  it("decodes valid FMMT topology buffers", () => {
    const decoded = decodeTopology(makeTopologyBuffer());

    expect(decoded.nodeCount).toBe(4);
    expect(decoded.elementCount).toBe(1);
    expect(Array.from(decoded.indices)).toEqual([0, 1, 2, 3]);
    expect(Array.from(decoded.boundaryMarkers)).toEqual([20]);
  });

  it("rejects topology buffers with out-of-range indices", () => {
    const buffer = makeTopologyBuffer();
    const indexOffset = 32 + 4 * 3 * Float64Array.BYTES_PER_ELEMENT;
    new Uint32Array(buffer, indexOffset, 4).set([0, 1, 2, 9]);

    expect(() => decodeTopology(buffer)).toThrow(/out of range/);
  });

  it("rejects unsupported topology payload kinds", () => {
    const buffer = makeTopologyBuffer();
    new DataView(buffer).setUint8(5, 2);

    expect(() => decodeTopology(buffer)).toThrow(/Unsupported FMMT topology kind/);
  });
});
