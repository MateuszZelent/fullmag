import { describe, expect, it } from "vitest";

import {
  decodeTopology,
  decodeTopologyHeader,
  expectedTopologyByteLength,
  topologyByteLayout,
} from "./topologyCodec";

const FMMT_V2_HEADER_LEN = 64;

function alignToEight(value: number): number {
  return Math.ceil(value / 8) * 8;
}

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

function makeMixedTopologyBuffer(): ArrayBuffer {
  const positions = [
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
    1, 0, 1,
    0, 1, 1,
    1, 1, 1,
    1, 1, 0,
  ];
  const cellTypes = [1, 2, 3, 4];
  const cellOffsets = [0, 4, 10, 15, 23];
  const cellNodes = [
    0, 1, 2, 3,
    0, 1, 2, 4, 5, 6,
    0, 1, 7, 2, 6,
    0, 1, 7, 2, 3, 4, 6, 5,
  ];
  const facetTypes = [1, 2];
  const facetRoles = [1, 2];
  const facetOffsets = [0, 3, 7];
  const facetNodes = [0, 1, 2, 0, 1, 4, 3];
  const cellMarkers = [10, 11, 12, 13];
  const facetMarkers = [20, 21];

  let offset = FMMT_V2_HEADER_LEN;
  const positionsOffset = offset;
  offset = alignToEight(offset + positions.length * 8);
  const cellTypesOffset = offset;
  offset = alignToEight(offset + cellTypes.length * 4);
  const cellOffsetsOffset = offset;
  offset = alignToEight(offset + cellOffsets.length * 4);
  const cellNodesOffset = offset;
  offset = alignToEight(offset + cellNodes.length * 4);
  const facetTypesOffset = offset;
  offset = alignToEight(offset + facetTypes.length * 4);
  const facetRolesOffset = offset;
  offset = alignToEight(offset + facetRoles.length * 4);
  const facetOffsetsOffset = offset;
  offset = alignToEight(offset + facetOffsets.length * 4);
  const facetNodesOffset = offset;
  offset = alignToEight(offset + facetNodes.length * 4);
  const cellMarkersOffset = offset;
  offset = alignToEight(offset + cellMarkers.length * 4);
  const facetMarkersOffset = offset;
  const byteLength = facetMarkersOffset + facetMarkers.length * 4;

  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMMT"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint8(4, 2);
  view.setUint8(5, 1);
  view.setUint32(8, positions.length / 3, true);
  view.setUint32(12, cellTypes.length, true);
  view.setUint32(16, facetTypes.length, true);
  view.setUint32(20, cellNodes.length, true);
  view.setUint32(24, facetNodes.length, true);
  view.setUint32(28, cellMarkers.length, true);
  view.setUint32(32, facetMarkers.length, true);
  view.setUint32(36, FMMT_V2_HEADER_LEN, true);

  new Float64Array(buffer, positionsOffset, positions.length).set(positions);
  new Uint32Array(buffer, cellTypesOffset, cellTypes.length).set(cellTypes);
  new Uint32Array(buffer, cellOffsetsOffset, cellOffsets.length).set(cellOffsets);
  new Uint32Array(buffer, cellNodesOffset, cellNodes.length).set(cellNodes);
  new Uint32Array(buffer, facetTypesOffset, facetTypes.length).set(facetTypes);
  new Uint32Array(buffer, facetRolesOffset, facetRoles.length).set(facetRoles);
  new Uint32Array(buffer, facetOffsetsOffset, facetOffsets.length).set(facetOffsets);
  new Uint32Array(buffer, facetNodesOffset, facetNodes.length).set(facetNodes);
  new Uint32Array(buffer, cellMarkersOffset, cellMarkers.length).set(cellMarkers);
  new Uint32Array(buffer, facetMarkersOffset, facetMarkers.length).set(facetMarkers);
  return buffer;
}

describe("decodeTopology", () => {
  it("normalizes valid FMMT v1 tetra topology to canonical CSR", () => {
    const decoded = decodeTopology(makeTopologyBuffer());

    expect(decoded.nodeCount).toBe(4);
    expect(decoded.elementCount).toBe(1);
    expect(decoded.formatVersion).toBe(1);
    expect(Array.from(decoded.cellTypes ?? [])).toEqual([1]);
    expect(Array.from(decoded.cellOffsets ?? [])).toEqual([0, 4]);
    expect(Array.from(decoded.cellNodes ?? [])).toEqual([0, 1, 2, 3]);
    expect(Array.from(decoded.facetTypes ?? [])).toEqual([1]);
    expect(Array.from(decoded.facetRoles ?? [])).toEqual([1]);
    expect(Array.from(decoded.facetOffsets ?? [])).toEqual([0, 3]);
    expect(Array.from(decoded.facetNodes ?? [])).toEqual([0, 1, 2]);
    expect(Array.from(decoded.cellMarkers ?? [])).toEqual([10]);
    expect(Array.from(decoded.facetMarkers ?? [])).toEqual([20]);
    expect(Array.from(decoded.indices)).toEqual([0, 1, 2, 3]);
    expect(Array.from(decoded.boundaryMarkers)).toEqual([20]);
  });

  it("decodes valid mixed FMMT v2 topology and empties unsafe legacy aliases", () => {
    const decoded = decodeTopology(makeMixedTopologyBuffer());

    expect(decoded.formatVersion).toBe(2);
    expect(decoded.nodeCount).toBe(8);
    expect(decoded.cellCount).toBe(4);
    expect(decoded.facetCount).toBe(2);
    expect(Array.from(decoded.cellTypes ?? [])).toEqual([1, 2, 3, 4]);
    expect(Array.from(decoded.cellOffsets ?? [])).toEqual([0, 4, 10, 15, 23]);
    expect(Array.from(decoded.cellNodes ?? [])).toHaveLength(23);
    expect(Array.from(decoded.facetTypes ?? [])).toEqual([1, 2]);
    expect(Array.from(decoded.facetRoles ?? [])).toEqual([1, 2]);
    expect(Array.from(decoded.facetOffsets ?? [])).toEqual([0, 3, 7]);
    expect(Array.from(decoded.cellMarkers ?? [])).toEqual([10, 11, 12, 13]);
    expect(Array.from(decoded.facetMarkers ?? [])).toEqual([20, 21]);
    expect(decoded.elementCount).toBe(4);
    expect(decoded.indices).toHaveLength(0);
    expect(decoded.elementMarkers).toBe(decoded.cellMarkers);
    expect(decoded.boundaryFaceCount).toBe(2);
    expect(decoded.boundaryFaces).toHaveLength(0);
    expect(decoded.boundaryMarkers).toBe(decoded.facetMarkers);
  });

  it("decodes FMMT header and byte layout for chunked topology reads", () => {
    const buffer = makeTopologyBuffer();
    const header = decodeTopologyHeader(buffer.slice(0, 32));
    const layout = topologyByteLayout(header);

    expect(header).toMatchObject({
      boundaryFaceCount: 1,
      boundaryMarkerCount: 1,
      elementCount: 1,
      elementMarkerCount: 1,
      nodeCount: 4,
    });
    expect(expectedTopologyByteLength(header)).toBe(buffer.byteLength);
    expect(layout.positions).toEqual({ start: 32, end: 127 });
    expect(layout.expectedByteLength).toBe(buffer.byteLength);
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

  it("rejects truncated and misaligned FMMT v2 payloads", () => {
    const valid = makeMixedTopologyBuffer();
    expect(() => decodeTopology(valid.slice(0, valid.byteLength - 1))).toThrow(
      /size mismatch/,
    );

    const misaligned = valid.slice(0);
    new DataView(misaligned).setUint32(36, 63, true);
    expect(() => decodeTopology(misaligned)).toThrow(/header length.*aligned/i);
  });

  it("rejects FMMT v2 section-size overflow before allocating", () => {
    const buffer = makeMixedTopologyBuffer().slice(0, FMMT_V2_HEADER_LEN);
    new DataView(buffer).setUint32(8, 0xffff_ffff, true);

    expect(() => expectedTopologyByteLength(decodeTopologyHeader(buffer))).toThrow(
      /overflow/,
    );
  });

  it("rejects unknown FMMT v2 cell, facet, and role codes", () => {
    const cases = [
      { offset: 256, message: /cell type code/ },
      { offset: 392, message: /facet type code/ },
      { offset: 400, message: /facet role code/ },
    ];
    for (const { offset, message } of cases) {
      const buffer = makeMixedTopologyBuffer();
      new Uint32Array(buffer, offset, 1)[0] = 99;
      expect(() => decodeTopology(buffer)).toThrow(message);
    }
  });
});
