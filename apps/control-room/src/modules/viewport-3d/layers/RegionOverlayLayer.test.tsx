import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("RegionOverlayLayer", () => {
  it("does not render authored region overlays through unrelated scene geometry", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./RegionOverlayLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).not.toContain("depthTest={false}");
  });
});
