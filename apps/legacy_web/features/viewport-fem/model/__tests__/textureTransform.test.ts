import { describe, expect, it } from "vitest";

import {
  textureScaleSemantics,
  TEXTURE_PROJECTION_MODES,
  fitTextureToBounds,
  fitPresetParamsToBounds,
} from "@/lib/textureTransform";

describe("textureScaleSemantics", () => {
  it("returns identity_metric for vortex", () => {
    expect(textureScaleSemantics("vortex")).toBe("identity_metric");
  });
  it("returns identity_metric for bloch_skyrmion", () => {
    expect(textureScaleSemantics("bloch_skyrmion")).toBe("identity_metric");
  });
  it("returns identity_metric for neel_skyrmion", () => {
    expect(textureScaleSemantics("neel_skyrmion")).toBe("identity_metric");
  });
  it("returns identity_metric for domain_wall", () => {
    expect(textureScaleSemantics("domain_wall")).toBe("identity_metric");
  });
  it("returns identity_metric for antivortex", () => {
    expect(textureScaleSemantics("antivortex")).toBe("identity_metric");
  });
  it("returns size_multiplier for uniform", () => {
    expect(textureScaleSemantics("uniform")).toBe("size_multiplier");
  });
  it("returns size_multiplier for random", () => {
    expect(textureScaleSemantics("random")).toBe("size_multiplier");
  });
  it("returns size_multiplier for helical", () => {
    expect(textureScaleSemantics("helical")).toBe("size_multiplier");
  });
  it("returns size_multiplier for unknown presets", () => {
    expect(textureScaleSemantics("custom_foo")).toBe("size_multiplier");
  });
});

describe("TEXTURE_PROJECTION_MODES", () => {
  it("has 4 entries", () => {
    expect(TEXTURE_PROJECTION_MODES).toHaveLength(4);
  });
  it("includes object_local as first entry", () => {
    expect(TEXTURE_PROJECTION_MODES[0].value).toBe("object_local");
  });
  it("values are unique", () => {
    const values = TEXTURE_PROJECTION_MODES.map((m) => m.value);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("fitTextureToBounds", () => {
  it("produces scale = extent for non-metric presets", () => {
    const tf = fitTextureToBounds([0, 0, 0], [2, 4, 6]);
    expect(tf.scale).toEqual([2, 4, 6]);
    expect(tf.translation).toEqual([1, 2, 3]);
  });
});

describe("fitPresetParamsToBounds", () => {
  it("keeps scale at identity for metric presets", () => {
    const result = fitPresetParamsToBounds("vortex", { plane: "xy" }, [0, 0, 0], [10, 10, 1]);
    expect(result.transform.scale).toEqual([1, 1, 1]);
  });
  it("adjusts core_radius for vortex", () => {
    const result = fitPresetParamsToBounds("vortex", { plane: "xy" }, [0, 0, 0], [10, 10, 1]);
    expect(result.params.core_radius).toBeCloseTo(0.12 * 10);
  });
});
