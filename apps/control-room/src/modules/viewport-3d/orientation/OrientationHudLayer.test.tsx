import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const sourceUrl = new URL("./OrientationHudLayer.tsx", import.meta.url);

describe("OrientationHudLayer", () => {
  it("commits HUD camera changes through the registry callback without a parallel store write", () => {
    const source = readFileSync(sourceUrl, "utf8");
    const snapStart = source.indexOf("const snapToDirection");
    const commitEnd = source.indexOf("useEffect(", source.indexOf("const commitOrbit"));
    const cameraCommitBlock = source.slice(snapStart, commitEnd);

    expect(cameraCommitBlock).toContain("commitCameraChange(nextCamera)");
    expect(cameraCommitBlock).toContain("onCameraChange(nextCamera)");
    expect(cameraCommitBlock).not.toContain("viewport3dStore.setCamera(");
  });

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
