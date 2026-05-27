import { describe, expect, it } from "vitest";

import { buildViewport3DPointPositions } from "./viewport3dPointGeometry";

const source = {
  nodeCount: 5,
  positions: new Float32Array([
    0, 0, 0,
    1, 0, 0,
    2, 0, 0,
    3, 0, 0,
    4, 0, 0,
  ]),
};

describe("viewport3dPointGeometry", () => {
  it("builds full-scope point positions from every mesh node", () => {
    expect(Array.from(buildViewport3DPointPositions(source, null) ?? []))
      .toEqual(Array.from(source.positions));
  });

  it("builds surface-scope point positions from the selected surface nodes only", () => {
    expect(
      Array.from(
        buildViewport3DPointPositions(source, { nodeIndices: [1, 3] }) ?? [],
      ),
    ).toEqual([
      1, 0, 0,
      3, 0, 0,
    ]);
  });
});
