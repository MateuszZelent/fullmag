import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("RegionMeshOverlayLayer", () => {
  it("consumes the region overlay build-model boundary instead of deriving directly in the layer", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./RegionMeshOverlayLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("buildViewport3DRegionOverlayModels");
    expect(source).not.toContain("buildRegionMeshOverlayModels(");
  });

  it("uses depth-tested selection-shell policy for realized region surfaces", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./RegionMeshOverlayLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain(
      "renderOrder={RENDER_POLICIES.selectionShell.renderOrder}",
    );
    expect(source).toContain('materialPolicyProps("selectionShell")');
    expect(source).toContain("colorWrite={model.surfaceOverlayVisible}");
    expect(source).toContain(
      "model.surfaceOverlayVisible && model.style.fillOpacity >= 1",
    );
    expect(source).toContain(
      "!model.surfaceOverlayVisible || model.style.fillOpacity < 1",
    );
    expect(source).not.toContain("depthTest={false}");
    expect(source).not.toContain("computeVertexNormals");
  });
});
