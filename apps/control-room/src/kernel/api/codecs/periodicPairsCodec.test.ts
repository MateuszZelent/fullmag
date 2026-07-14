import { describe, expect, it } from "vitest";

import { decodePeriodicPairs } from "./periodicPairsCodec";

function makeBuffer(): ArrayBuffer {
  const encoder = new TextEncoder();
  const pairId = encoder.encode("x_periodic");
  const byteLength =
    20 + 4 + pairId.byteLength + 4 + 4 + 4 + 4 + 8 + 8 + 8 + 4 + 4 * 2;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes.set([..."FMPP"].map((value) => value.charCodeAt(0)), 0);
  view.setUint8(4, 1);
  view.setUint8(5, 1);
  view.setBigUint64(8, BigInt(41), true);
  view.setUint32(16, 1, true);
  let offset = 20;
  view.setUint32(offset, pairId.byteLength, true);
  offset += 4;
  bytes.set(pairId, offset);
  offset += pairId.byteLength;
  view.setUint32(offset, 10, true);
  offset += 4;
  view.setUint32(offset, 11, true);
  offset += 4;
  view.setUint32(offset, 1, true);
  offset += 4;
  view.setUint32(offset, 1, true);
  offset += 4;
  view.setUint32(offset, 0, true);
  offset += 4;
  view.setUint32(offset, 1, true);
  offset += 4;
  view.setBigUint64(offset, BigInt(0), true);
  offset += 8;
  view.setBigUint64(offset, BigInt(1), true);
  offset += 8;
  view.setUint32(offset, 1, true);
  offset += 4;
  view.setUint32(offset, 0, true);
  offset += 4;
  view.setUint32(offset, 0, true);
  offset += 4;
  view.setUint32(offset, 1, true);
  return buffer;
}

describe("FMPP.v1 codec", () => {
  it("decodes status, revision and explicit node/face vertex mappings", () => {
    const decoded = decodePeriodicPairs(makeBuffer());
    expect(decoded.status).toBe("valid");
    expect(decoded.revision).toBe(41);
    expect(decoded.pairs).toEqual([
      {
        facePairs: [{ faceA: 0, faceB: 1, vertexPairs: [[0, 1]] }],
        markerA: 10,
        markerB: 11,
        nodePairs: [[0, 1]],
        pairId: "x_periodic",
      },
    ]);
  });

  it("rejects truncated or trailing payloads", () => {
    expect(() => decodePeriodicPairs(makeBuffer().slice(0, -1))).toThrow(
      /truncated|size mismatch/,
    );
    const withTrailing = new Uint8Array(makeBuffer().byteLength + 1);
    withTrailing.set(new Uint8Array(makeBuffer()));
    expect(() => decodePeriodicPairs(withTrailing.buffer)).toThrow(/trailing/);
  });
});
