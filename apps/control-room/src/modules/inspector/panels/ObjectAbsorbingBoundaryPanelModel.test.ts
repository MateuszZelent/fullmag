import { describe, expect, it } from "vitest";

import {
  absorbingBoundaryDraftFromObject,
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
