import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src/modules/viewport-2d/Viewport2DModule.tsx"),
  "utf8",
);

describe("Viewport2DModule resource ownership", () => {
  it("loads cross-section payloads through kernel resource hooks", () => {
    expect(source).toContain("useCrossSectionResource");
    expect(source).toContain("useCrossSectionQualityResource");
    expect(source).not.toContain("kernel.api.meshing.sharedDomain.crossSection");
    expect(source).not.toContain("kernel.api.meshing.sharedDomain.crossSectionQuality");
  });
});
