import { describe, expect, it } from "vitest";

import {
  buildMaterialAssignmentPatch,
  materialAssignmentDraftFromRef,
  normalizeMaterialRef,
} from "./ObjectMaterialPanelModel";

describe("ObjectMaterialPanelModel", () => {
  it("normalizes empty and unassigned material references as cleared assignments", () => {
    expect(normalizeMaterialRef("")).toBeNull();
    expect(normalizeMaterialRef("   ")).toBeNull();
    expect(normalizeMaterialRef("unassigned")).toBeNull();
    expect(normalizeMaterialRef("  permalloy ")).toBe("permalloy");
  });

  it("creates a material assignment draft from the current object material", () => {
    expect(materialAssignmentDraftFromRef("permalloy")).toEqual({
      materialRef: "permalloy",
    });
    expect(materialAssignmentDraftFromRef("unassigned")).toEqual({
      materialRef: "",
    });
  });

  it("builds the v2 object patch for assigning and clearing material", () => {
    expect(
      buildMaterialAssignmentPatch({ materialRef: "cofeb" }, 12),
    ).toEqual({
      base_revision: 12,
      material_ref: "cofeb",
    });

    expect(buildMaterialAssignmentPatch({ materialRef: "" }, null)).toEqual({
      base_revision: null,
      material_ref: null,
    });
  });
});
