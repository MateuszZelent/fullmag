import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("MeshSizeHighlightLayer", () => {
  it("does not render mesh-size highlights as depth-bypassing hidden edges", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./MeshSizeHighlightLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).not.toContain('materialPolicyProps("hiddenEdges")');
    expect(source).not.toContain("RENDER_POLICIES.hiddenEdges.renderOrder");
  });
});
