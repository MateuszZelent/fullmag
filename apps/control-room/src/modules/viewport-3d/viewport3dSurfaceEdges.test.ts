import { describe, expect, it } from "vitest";

import {
  buildLineIndexGeometry,
  buildSurfaceEdgeIndices,
} from "./viewport3dSurfaceEdges";

describe("viewport3dSurfaceEdges", () => {
  it("deduplicates triangle edges for a line-segment wireframe pass", () => {
    const edges = buildSurfaceEdgeIndices(
      new Uint32Array([
        0, 1, 2,
        2, 1, 3,
      ]),
    );

    expect(Array.from(edges ?? [])).toEqual([
      0, 1,
      1, 2,
      0, 2,
      1, 3,
      2, 3,
    ]);
  });

  it("deduplicates large node ids without numeric pairing collisions", () => {
    const largeNodeId = 94_906_266;
    const edges = buildSurfaceEdgeIndices(
      new Uint32Array([0, largeNodeId, 1]),
    );

    expect(Array.from(edges ?? [])).toEqual([
      0, largeNodeId,
      1, largeNodeId,
      0, 1,
    ]);
  });

  it("rejects malformed triangle index buffers", () => {
    expect(buildSurfaceEdgeIndices(new Uint32Array([0, 1]))).toBeNull();
    expect(buildSurfaceEdgeIndices(new Uint32Array())).toBeNull();
  });

  it("builds line-index geometry for dedicated volume edge passes", () => {
    const lineIndices = new Uint32Array([0, 1, 1, 2]);
    const geometry = buildLineIndexGeometry(
      new Float32Array([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
      ]),
      lineIndices,
    );

    expect(Array.from(geometry?.getIndex()?.array ?? [])).toEqual([0, 1, 1, 2]);
    expect(geometry?.getIndex()?.array).toBe(lineIndices);
    expect(geometry?.getAttribute("position").count).toBe(3);
  });

  it("shares topology positions across independent wireframe passes", () => {
    const positions = new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
    ]);
    const first = buildLineIndexGeometry(positions, new Uint32Array([0, 1]));
    const second = buildLineIndexGeometry(positions, new Uint32Array([1, 2]));

    expect(first?.getAttribute("position")).toBe(second?.getAttribute("position"));

    first?.dispose();
    second?.dispose();
  });
});
