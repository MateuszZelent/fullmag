import { describe, expect, it } from "vitest";
import {
  arrayBufferTransferList,
  decodedPayloadTransferList,
} from "../transferables";
import type { DecodedFieldVector, DecodedTopology } from "../types";

describe("binary codec transfer lists", () => {
  it("transfers non-empty request buffers", () => {
    const buffer = new ArrayBuffer(32);
    expect(arrayBufferTransferList(buffer)).toEqual([buffer]);
  });

  it("skips empty request buffers", () => {
    expect(arrayBufferTransferList(new ArrayBuffer(0))).toEqual([]);
  });

  it("transfers decoded field vector values", () => {
    const values = new Float64Array(12);
    const payload: DecodedFieldVector = {
      quantityId: "m",
      nComp: 3,
      grid: [2, 2, 1],
      pointCount: 4,
      valueCount: 12,
      dtype: "float64",
      values,
    };

    expect(decodedPayloadTransferList(payload)).toEqual([values.buffer]);
  });

  it("transfers each decoded topology buffer once", () => {
    const positions = new Float64Array(9);
    const indices = new Uint32Array(4);
    const boundaryFaces = new Uint32Array(3);
    const elementMarkers = new Uint32Array(1);
    const boundaryMarkers = new Uint32Array(1);
    const payload: DecodedTopology = {
      nodeCount: 3,
      elementCount: 1,
      boundaryFaceCount: 1,
      positions,
      indices,
      boundaryFaces,
      elementMarkers,
      boundaryMarkers,
    };

    expect(decodedPayloadTransferList(payload)).toEqual([
      positions.buffer,
      indices.buffer,
      boundaryFaces.buffer,
      elementMarkers.buffer,
      boundaryMarkers.buffer,
    ]);
  });
});
