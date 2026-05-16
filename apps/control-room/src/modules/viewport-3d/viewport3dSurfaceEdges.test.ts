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

  it("rejects malformed triangle index buffers", () => {
    expect(buildSurfaceEdgeIndices(new Uint32Array([0, 1]))).toBeNull();
    expect(buildSurfaceEdgeIndices(new Uint32Array())).toBeNull();
  });

  it("builds line-index geometry for dedicated volume edge passes", () => {
    const geometry = buildLineIndexGeometry(
      new Float32Array([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
      ]),
      new Uint32Array([0, 1, 1, 2]),
    );

    expect(Array.from(geometry?.getIndex()?.array ?? [])).toEqual([0, 1, 1, 2]);
    expect(geometry?.getAttribute("position").count).toBe(3);
  });
});
