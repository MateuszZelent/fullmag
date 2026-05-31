import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");

describe("RootLayout runtime config", () => {
  it("injects a temporary viewport diagnostics baseline", () => {
    expect(source).toContain("window.__FULLMAG_CONFIG__");
    expect(source).toContain("next/script");
    expect(source).toContain("disablePerformanceDiagnostics: true");
    expect(source).toContain("disableViewport3DOverlayLayers:");
    expect(source).toContain("disableViewport3DDimensionFrame:");
    expect(source).toContain("disableViewport3DSceneLayers: true");
    expect(source).toContain("disableViewport3DOrientationHud: true");
    expect(source).toContain("disableViewport3DPostProcessing: true");
  });
});
