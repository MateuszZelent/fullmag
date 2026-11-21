import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { resolveViewport3DPostProcessingPolicy } from "./PostProcessingLayer.model";

describe("viewport3D post-processing policy", () => {
  it("protects quantitative colors in Scientific and allows Presentation shading in both switch directions", () => {
    const scientific = resolveViewport3DPostProcessingPolicy({
      available: true,
      quantitativeDataVisible: true,
      renderMode: "scientific",
    });
    expect(scientific).toEqual({ dataProtected: true, enabled: false });

    const presentation = resolveViewport3DPostProcessingPolicy({
      available: true,
      quantitativeDataVisible: true,
      renderMode: "presentation",
    });
    expect(presentation).toEqual({ dataProtected: false, enabled: true });

    const returnedToScientific = resolveViewport3DPostProcessingPolicy({
      available: true,
      quantitativeDataVisible: true,
      renderMode: "scientific",
    });
    expect(returnedToScientific).toEqual(scientific);
  });

  it("keeps browser availability separate from Scientific data protection", () => {
    expect(resolveViewport3DPostProcessingPolicy({
      available: true,
      quantitativeDataVisible: false,
      renderMode: "scientific",
    })).toEqual({ dataProtected: false, enabled: true });

    expect(resolveViewport3DPostProcessingPolicy({
      available: false,
      quantitativeDataVisible: true,
      renderMode: "presentation",
    })).toEqual({ dataProtected: false, enabled: false });
  });

  it("sends the same mode-aware protection state to settings diagnostics", () => {
    const source = readFileSync(new URL("./PostProcessingLayer.tsx", import.meta.url), "utf8");

    expect(source).toContain("const postProcessingPolicy = resolveViewport3DPostProcessingPolicy({");
    expect(source).toContain("const enabled = postProcessingPolicy.enabled;");
    expect(source).toContain("viewport3dStore.setPostProcessingDataProtection(postProcessingPolicy.dataProtected);");
  });
});
