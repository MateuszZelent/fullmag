import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("RegionMeshOverlayLayer", () => {
  it("uses depth-tested selection-shell policy for realized region surfaces", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./RegionMeshOverlayLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain(
      "renderOrder={RENDER_POLICIES.selectionShell.renderOrder}",
    );
    expect(source).toContain('materialPolicyProps("selectionShell")');
    expect(source).not.toContain("depthTest={false}");
    expect(source).not.toContain("computeVertexNormals");
  });
});
