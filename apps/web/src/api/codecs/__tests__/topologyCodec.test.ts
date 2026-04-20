import { describe, it, expect } from "vitest";
import { decodeTopology } from "../topologyCodec";

/**
 * Build a valid FMMT v1 buffer.
 *
 * Creates a minimal tetrahedron mesh with boundary faces and markers.
 */
function buildFmmtBuffer(opts?: {
  nodeCount?: number;
  elementCount?: number;
  boundaryFaceCount?: number;
  elementMarkerCount?: number;
  boundaryMarkerCount?: number;
  positions?: number[];
  elements?: number[];
  boundaryFaces?: number[];
  elementMarkers?: number[];
  boundaryMarkers?: number[];
}): ArrayBuffer {
  const nodeCount = opts?.nodeCount ?? 4;
  const elementCount = opts?.elementCount ?? 1;
  const boundaryFaceCount = opts?.boundaryFaceCount ?? 4;
  const elementMarkerCount = opts?.elementMarkerCount ?? 1;
  const boundaryMarkerCount = opts?.boundaryMarkerCount ?? 4;

  const headerLen = 32;
  const nodesBytes = nodeCount * 3 * 8;
  const elemBytes = elementCount * 4 * 4;
  const bfBytes = boundaryFaceCount * 3 * 4;
  const emBytes = elementMarkerCount * 4;
  const bmBytes = boundaryMarkerCount * 4;
  const totalBytes = headerLen + nodesBytes + elemBytes + bfBytes + emBytes + bmBytes;

  const buf = new ArrayBuffer(totalBytes);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // Magic "FMMT"
  u8[0] = 0x46; // F
  u8[1] = 0x4d; // M
  u8[2] = 0x4d; // M
  u8[3] = 0x54; // T

  view.setUint8(4, 1); // version
  view.setUint32(8, nodeCount, true);
  view.setUint32(12, elementCount, true);
  view.setUint32(16, boundaryFaceCount, true);
  view.setUint32(20, elementMarkerCount, true);
  view.setUint32(24, boundaryMarkerCount, true);

  let offset = headerLen;

  // Nodes (nodeCount * 3 float64)
  const positions = opts?.positions ?? [
    0.0, 0.0, 0.0,
    1.0, 0.0, 0.0,
    0.0, 1.0, 0.0,
    0.0, 0.0, 1.0,
  ];
  const f64 = new Float64Array(buf, offset, nodeCount * 3);
  f64.set(positions);
  offset += nodesBytes;

  // Elements (elementCount * 4 uint32)
  const elements = opts?.elements ?? [0, 1, 2, 3];
  const u32elem = new Uint32Array(buf, offset, elementCount * 4);
  u32elem.set(elements);
  offset += elemBytes;

  // Boundary faces (boundaryFaceCount * 3 uint32)
  const bfDefault = [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3];
  const bf = opts?.boundaryFaces ?? bfDefault;
  const u32bf = new Uint32Array(buf, offset, boundaryFaceCount * 3);
  u32bf.set(bf);
  offset += bfBytes;

  // Element markers
  const em = opts?.elementMarkers ?? [1];
  const u32em = new Uint32Array(buf, offset, elementMarkerCount);
  u32em.set(em);
  offset += emBytes;

  // Boundary markers
  const bm = opts?.boundaryMarkers ?? [1, 1, 1, 1];
  const u32bm = new Uint32Array(buf, offset, boundaryMarkerCount);
  u32bm.set(bm);

  return buf;
}

describe("decodeTopology (FMMT v1)", () => {
  it("decodes a valid buffer with known tetrahedron data", () => {
    const buf = buildFmmtBuffer();
    const topo = decodeTopology(buf);

    expect(topo.nodeCount).toBe(4);
    expect(topo.elementCount).toBe(1);
    expect(topo.boundaryFaceCount).toBe(4);
    expect(topo.positions.length).toBe(12); // 4 nodes * 3
    expect(topo.indices.length).toBe(4);    // 1 element * 4
    expect(topo.boundaryFaces.length).toBe(12); // 4 faces * 3
    expect(topo.elementMarkers.length).toBe(1);
    expect(topo.boundaryMarkers.length).toBe(4);

    // Verify node positions
    expect(topo.positions[0]).toBe(0.0);
    expect(topo.positions[3]).toBe(1.0);
    expect(topo.positions[6]).toBe(0.0);
    expect(topo.positions[7]).toBe(1.0);
  });

  it("rejects buffer with invalid magic", () => {
    const buf = buildFmmtBuffer();
    const u8 = new Uint8Array(buf);
    u8[0] = 0x00;
    expect(() => decodeTopology(buf)).toThrow(/Invalid FMMT magic/);
  });

  it("rejects buffer too small for header", () => {
    const buf = new ArrayBuffer(16);
    expect(() => decodeTopology(buf)).toThrow(/too short/);
  });

  it("rejects buffer with mismatched size", () => {
    // Valid header but truncated payload
    const buf = new ArrayBuffer(32);
    const view = new DataView(buf);
    const u8 = new Uint8Array(buf);
    u8[0] = 0x46; u8[1] = 0x4d; u8[2] = 0x4d; u8[3] = 0x54;
    view.setUint8(4, 1);
    view.setUint32(8, 10, true); // 10 nodes → need much more space
    expect(() => decodeTopology(buf)).toThrow(/size mismatch/);
  });

  it("rejects unsupported version", () => {
    const buf = buildFmmtBuffer();
    const view = new DataView(buf);
    view.setUint8(4, 99);
    expect(() => decodeTopology(buf)).toThrow(/Unsupported FMMT version/);
  });

  it("decodes buffer with zero boundary faces and markers", () => {
    const buf = buildFmmtBuffer({
      nodeCount: 4,
      elementCount: 1,
      boundaryFaceCount: 0,
      elementMarkerCount: 0,
      boundaryMarkerCount: 0,
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      elements: [0, 1, 2, 3],
      boundaryFaces: [],
      elementMarkers: [],
      boundaryMarkers: [],
    });
    const topo = decodeTopology(buf);
    expect(topo.boundaryFaceCount).toBe(0);
    expect(topo.boundaryFaces.length).toBe(0);
    expect(topo.elementMarkers.length).toBe(0);
    expect(topo.boundaryMarkers.length).toBe(0);
  });
});
