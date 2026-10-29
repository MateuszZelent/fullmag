import { describe, expect, it } from "vitest";

import {
  buildSharedDomainPolicyConfig,
  draftFromSharedDomainResource,
} from "./sharedDomainMeshPolicyDraft";

// Shape returned by GET /meshing/policies/shared-domain for a fresh session:
// a serialized ScriptBuilderMeshState with text sizes and a text optimizer.
const BACKEND_DEFAULT_POLICY = {
  adaptive_enabled: false,
  algorithm_2d: 6,
  algorithm_3d: 1,
  compute_quality: true,
  growth_rate: "",
  hmax: "",
  hmin: "",
  narrow_regions: 0,
  optimize: "",
  optimize_iterations: 1,
  per_element_quality: true,
  size_factor: 1,
  size_from_curvature: 0,
  smoothing_steps: 1,
};

describe("shared-domain mesh policy draft", () => {
  it("serializes UI edits in the ScriptBuilderMeshState wire format", () => {
    const draft = {
      ...draftFromSharedDomainResource({ config: BACKEND_DEFAULT_POLICY }),
      growthRate: "1.3",
      hMax: "1e-8",
      hMin: "3e-9",
      narrowRegionResolution: "2",
      optimize: true,
    };

    const built = buildSharedDomainPolicyConfig(draft);

    expect(built).toEqual({
      ok: true,
      config: {
        ...BACKEND_DEFAULT_POLICY,
        growth_rate: "1.3",
        hmax: "1e-8",
        hmin: "3e-9",
        narrow_region_resolution: "2",
        optimize: "Netgen",
      },
    });
  });

  it("reads committed policies back into the same fields", () => {
    const draft = draftFromSharedDomainResource({
      config: { ...BACKEND_DEFAULT_POLICY, hmax: "1e-8", hmin: "3e-9", optimize: "HighOrder" },
    });

    expect(draft).toMatchObject({ hMax: "1e-8", hMin: "3e-9", optimize: true, optimizeMethod: "HighOrder" });
    expect(buildSharedDomainPolicyConfig(draft)).toMatchObject({
      config: { hmax: "1e-8", hmin: "3e-9", optimize: "HighOrder" },
    });
  });

  it("disables the optimizer with an empty string and drops legacy keys", () => {
    const draft = {
      ...draftFromSharedDomainResource({
        config: { ...BACKEND_DEFAULT_POLICY, h_max: 1e-8, optimize: "Netgen" },
      }),
      optimize: false,
    };

    const built = buildSharedDomainPolicyConfig(draft);

    expect(built.ok && built.config.optimize).toBe("");
    expect(built.ok && "h_max" in built.config).toBe(false);
  });

  it("keeps a script-authored COMSOL alias as the edited key", () => {
    const draft = {
      ...draftFromSharedDomainResource({
        config: { ...BACKEND_DEFAULT_POLICY, maximum_element_size: "4e-8" },
      }),
      hMax: "2e-8",
    };

    expect(buildSharedDomainPolicyConfig(draft)).toMatchObject({
      config: { hmax: "", maximum_element_size: "2e-8" },
    });
  });

  it("rejects non-positive sizes", () => {
    const draft = {
      ...draftFromSharedDomainResource({ config: BACKEND_DEFAULT_POLICY }),
      hMax: "-1",
    };

    expect(buildSharedDomainPolicyConfig(draft)).toEqual({
      error: "Global maximum element size (h_max) must be greater than 0.",
      ok: false,
    });
  });
});
