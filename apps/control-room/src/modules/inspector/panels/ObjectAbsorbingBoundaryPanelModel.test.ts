import { describe, expect, it } from "vitest";

import {
  absorbingBoundaryDraftFromObject,
  absorbingBoundaryDraftKey,
  buildAbsorbingBoundaryPatch,
} from "./ObjectAbsorbingBoundaryPanelModel";

describe("ObjectAbsorbingBoundaryPanelModel", () => {
  it("normalizes an object-owned boundary into an editable draft", () => {
    expect(
      absorbingBoundaryDraftFromObject({
        absorbing_boundary: {
          total_width_m: 4e-7,
          ramp_width_m: 3e-7,
          max_damping: 0.5,
          faces: ["x+", "y-"],
          profile: "smootherstep",
          frame: "universe",
        },
      }),
    ).toEqual({
      enabled: true,
      totalWidth: "4e-7",
      rampWidth: "3e-7",
      maxDamping: "0.5",
      faces: ["x+", "y-"],
      profile: "smootherstep",
      frame: "universe",
      expression: "",
    });
  });

  it("exposes preset profiles and sends an expression only for a custom profile", () => {
    const draft = absorbingBoundaryDraftFromObject({
      absorbing_boundary: {
        total_width_m: 4e-7,
        ramp_width_m: 3e-7,
        max_damping: 0.5,
        faces: ["x+"],
        profile: "custom",
        expression: "u**3",
      },
    });
    expect(draft.expression).toBe("u**3");
    expect(buildAbsorbingBoundaryPatch(draft, 4)).toMatchObject({
      patch: { absorbing_boundary: { profile: "custom", expression: "u**3" } },
    });
    expect(buildAbsorbingBoundaryPatch({ ...draft, expression: " " }, 4)).toHaveProperty("error");
    for (const profile of ["logarithmic", "tanh"]) {
      const result = buildAbsorbingBoundaryPatch({ ...draft, profile }, 4);
      expect(result).toMatchObject({ patch: { absorbing_boundary: { profile } } });
      expect(result).not.toHaveProperty("patch.absorbing_boundary.expression");
      expect(absorbingBoundaryDraftKey({ ...draft, profile })).toBe(
        absorbingBoundaryDraftKey({ ...draft, profile, expression: "" }),
      );
    }
  });

  it("requires an explicit maximum damping and accepts zero", () => {
    const draft = { ...absorbingBoundaryDraftFromObject(null), enabled: true, faces: ["x+"] };
    for (const maxDamping of ["", "   "]) {
      expect(buildAbsorbingBoundaryPatch({ ...draft, maxDamping }, 4)).toHaveProperty("error");
    }
    expect(buildAbsorbingBoundaryPatch({ ...draft, maxDamping: "0" }, 4)).toMatchObject({
      patch: { absorbing_boundary: { max_damping: 0 } },
    });
  });

  it("builds a fail-closed patch for invalid widths and a typed object patch", () => {
    const invalid = buildAbsorbingBoundaryPatch(
      {
        enabled: true,
        totalWidth: "1e-7",
        rampWidth: "2e-7",
        maxDamping: "0.5",
        faces: ["x+"],
        profile: "smootherstep",
        frame: "object",
        expression: "",
      },
      4,
    );
    expect(invalid).toEqual({
      error: "Ramp width must be positive and no greater than total width.",
    });
    const valid = buildAbsorbingBoundaryPatch(
      {
        enabled: true,
        totalWidth: "4e-7",
        rampWidth: "3e-7",
        maxDamping: "0.5",
        faces: ["x+", "y-"],
        profile: "smootherstep",
        frame: "universe",
        expression: "",
      },
      4,
    );
    expect(valid).toEqual({
      patch: {
        base_revision: 4,
        absorbing_boundary: {
          total_width_m: 4e-7,
          ramp_width_m: 3e-7,
          max_damping: 0.5,
          faces: ["x+", "y-"],
          profile: "smootherstep",
          frame: "universe",
        },
      },
    });
  });
});
