import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const sourceUrl = new URL("./OrientationHudLayer.tsx", import.meta.url);

describe("OrientationHudLayer", () => {
  it("refreshes the camera world matrix before anchoring screen HUD widgets", () => {
    const source = readFileSync(sourceUrl, "utf8");
    const block = source.slice(
      source.indexOf("function updateScreenAnchor"),
      source.indexOf("function cameraNear"),
    );

    expect(block.indexOf("camera.updateMatrixWorld(true);")).toBeGreaterThanOrEqual(0);
    expect(block.indexOf("camera.updateMatrixWorld(true);")).toBeLessThan(
      block.indexOf("vectors.right.setFromMatrixColumn(camera.matrixWorld, 0)"),
    );
  });
});
