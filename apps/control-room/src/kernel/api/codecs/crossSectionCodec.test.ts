import { describe, expect, it } from "vitest";

import {
  decodeCrossSection,
  decodePlanarMeshOverlay,
  FMCS_HEADER_LEN,
} from "./crossSectionCodec";

const FMCS_V2_HEADER_LEN = 64;

function writeMagic(view: DataView): void {
  for (const [index, code] of [..."FMCS"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
}

function makeCrossSectionBuffer(): ArrayBuffer {
  return makeCrossSectionV2Buffer();
}

function makeCrossSectionV2Buffer(): ArrayBuffer {
  const polygonCount = 1;
  const vertexCount = 3;
  const segmentCount = 1;
  const buffer = new ArrayBuffer(
    FMCS_V2_HEADER_LEN +
      vertexCount * 2 * Float32Array.BYTES_PER_ELEMENT +
      (polygonCount + 1) * Uint32Array.BYTES_PER_ELEMENT +
      polygonCount * Uint32Array.BYTES_PER_ELEMENT +
      segmentCount * 4 * Float32Array.BYTES_PER_ELEMENT +
      vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT +
      vertexCount * 2 * Uint32Array.BYTES_PER_ELEMENT +
      vertexCount * Float32Array.BYTES_PER_ELEMENT +
      vertexCount * Uint32Array.BYTES_PER_ELEMENT,
  );
  const view = new DataView(buffer);
  writeMagic(view);
  view.setUint32(4, 2, true);
  view.setUint32(8, polygonCount, true);
  view.setUint32(12, vertexCount, true);
  view.setUint32(16, segmentCount, true);
  view.setUint32(20, polygonCount, true);
  view.setUint32(24, vertexCount, true);
  view.setUint32(28, 1, true);
  view.setFloat64(32, 0, true);
  view.setFloat64(40, 1, true);
  view.setFloat64(48, 0, true);
  view.setFloat64(56, 1, true);

  let offset = FMCS_V2_HEADER_LEN;
  new Float32Array(buffer, offset, vertexCount * 2).set([
    0, 0,
    0.5, 0,
    0, 0.5,
  ]);
  offset += vertexCount * 2 * Float32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, polygonCount + 1).set([0, 3]);
  offset += (polygonCount + 1) * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, polygonCount).set([7]);
  offset += polygonCount * Uint32Array.BYTES_PER_ELEMENT;
  new Float32Array(buffer, offset, segmentCount * 4).set([0, 0, 0.5, 0]);
  offset += segmentCount * 4 * Float32Array.BYTES_PER_ELEMENT;
  new Float32Array(buffer, offset, vertexCount * 3).set([
    0, 0, 0.5,
    0.5, 0, 0.5,
    0, 0.5, 0.5,
  ]);
  offset += vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, vertexCount * 2).set([0, 0, 0, 3, 1, 3]);
  offset += vertexCount * 2 * Uint32Array.BYTES_PER_ELEMENT;
  new Float32Array(buffer, offset, vertexCount).set([0, 0.5, 0.5]);
  offset += vertexCount * Float32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, vertexCount).set([1, 0, 0]);

  return buffer;
}

function makePlanarOverlayV4Buffer(segmentKinds = [0, 1, 2]): ArrayBuffer {
  const headerLength = 160;
  const polygonCount = 1;
  const vertexCount = 3;
  const segmentCount = segmentKinds.length;
  const buffer = new ArrayBuffer(
    headerLength +
      vertexCount * 2 * Float32Array.BYTES_PER_ELEMENT +
      (polygonCount + 1) * Uint32Array.BYTES_PER_ELEMENT +
      polygonCount * Uint32Array.BYTES_PER_ELEMENT +
      segmentCount * 4 * Float32Array.BYTES_PER_ELEMENT +
      segmentCount * Uint8Array.BYTES_PER_ELEMENT,
  );
  const view = new DataView(buffer);
  writeMagic(view);
  view.setUint32(4, 4, true);
  view.setUint32(8, polygonCount, true);
  view.setUint32(12, vertexCount, true);
  view.setUint32(16, segmentCount, true);
  view.setUint32(20, polygonCount, true);
  view.setUint32(24, segmentCount, true);
  view.setUint32(28, 2, true);
  view.setFloat64(32, 0, true);
  view.setFloat64(40, 1, true);
  view.setFloat64(48, 0, true);
  view.setFloat64(56, 1, true);
  const verticesOffset = headerLength;
  new Float32Array(buffer, verticesOffset, 6).set([0, 0, 1, 0, 0, 1]);
  const offsetsOffset = verticesOffset + 6 * Float32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offsetsOffset, 2).set([0, 3]);
  const parentOffset = offsetsOffset + 2 * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, parentOffset, 1).set([7]);
  const segmentsOffset = parentOffset + Uint32Array.BYTES_PER_ELEMENT;
  new Float32Array(buffer, segmentsOffset, segmentCount * 4).set(
    segmentKinds.flatMap((_kind, index) => [index, 0, index + 0.5, 1]),
  );
  new Uint8Array(
    buffer,
    segmentsOffset + segmentCount * 4 * Float32Array.BYTES_PER_ELEMENT,
    segmentCount,
  ).set(segmentKinds);
  return buffer;
}

function makePlanarOverlayV3Buffer(): ArrayBuffer {
  const v4 = makePlanarOverlayV4Buffer();
  const v3 = v4.slice(0, v4.byteLength - 3);
  new DataView(v3).setUint32(4, 3, true);
  return v3;
}

describe("crossSectionCodec", () => {
  it("decodes FMCS v2 intersection metadata for 3D cut-plane markers", () => {
    expect(FMCS_HEADER_LEN).toBe(FMCS_V2_HEADER_LEN);

    const decoded = decodeCrossSection(makeCrossSectionV2Buffer());

    expect([...decoded.intersectionWorld]).toEqual([
      0, 0, 0.5,
      0.5, 0, 0.5,
      0, 0.5, 0.5,
    ]);
    expect([...decoded.intersectionEdgeNodeIds]).toEqual([0, 0, 0, 3, 1, 3]);
    expect([...decoded.intersectionEdgeT]).toEqual([0, 0.5, 0.5]);
    expect([...decoded.intersectionKinds]).toEqual([1, 0, 0]);
  });

  it("decodes FMCS cross-section polygon and wireframe payloads", () => {
    const decoded = decodeCrossSection(makeCrossSectionBuffer());

    expect(decoded.polygonCount).toBe(1);
    expect(decoded.vertexCount).toBe(3);
    expect(decoded.segmentCount).toBe(1);
    expect(decoded.bounds).toEqual({ uMin: 0, uMax: 1, vMin: 0, vMax: 1 });
    expect([...decoded.vertices]).toEqual([0, 0, 0.5, 0, 0, 0.5]);
    expect([...decoded.polygonOffsets]).toEqual([0, 3]);
    expect([...decoded.parentElementIds]).toEqual([7]);
    expect([...decoded.segments]).toEqual([0, 0, 0.5, 0]);
  });

  it("rejects inconsistent polygon offsets", () => {
    const buffer = makeCrossSectionBuffer();
    new Uint32Array(buffer, FMCS_HEADER_LEN + 24, 2).set([0, 4]);

    expect(() => decodeCrossSection(buffer)).toThrow(/polygon offsets/);
  });

  it("decodes exact FMCS v4 planar segment classes without geometric inference", () => {
    const decoded = decodePlanarMeshOverlay(makePlanarOverlayV4Buffer());

    expect(decoded.codec).toBe("fmcs.v4");
    expect(decoded.boundaryClassification).toBe("exact");
    expect([...decoded.segmentKinds]).toEqual([0, 1, 2]);
  });

  it("rejects malformed FMCS v4 segment classifications", () => {
    expect(() => decodePlanarMeshOverlay(makePlanarOverlayV4Buffer([3]))).toThrow(
      /segment kind/,
    );
  });

  it("marks legacy FMCS v3 planar overlays as degraded without inferring boundaries", () => {
    const decoded = decodePlanarMeshOverlay(makePlanarOverlayV3Buffer());

    expect(decoded.codec).toBe("fmcs.v3");
    expect(decoded.boundaryClassification).toBe("degraded");
    expect([...decoded.segmentKinds]).toEqual([2, 2, 2]);
  });

  it("rejects a truncated FMCS v4 classification array", () => {
    const buffer = makePlanarOverlayV4Buffer();
    expect(() => decodePlanarMeshOverlay(buffer.slice(0, -1))).toThrow(/size mismatch/);
  });
});
