import { describe, expect, it } from "vitest";

import { buildSurfaceEdgeIndices } from "./viewport3dSurfaceEdges";

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
});
