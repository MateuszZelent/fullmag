import { describe, expect, it } from "vitest";

import {
  buildMaterialAssignmentPatch,
  buildMaterialParametersPatch,
  magneticParametersDraftFromResource,
  materialAssignmentDraftFromRef,
  materialParametersDraftKey,
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

  it("creates magnetic parameter drafts from material resources", () => {
    const resource = {
      id: "mat-1",
      name: "Material 1",
      properties: {
        Aex: 1e-11,
        Dind: null,
        Dbulk: null,
        Ms: 800000,
        alpha: 0.02,
      },
    };

    expect(magneticParametersDraftFromResource("mat-1", resource)).toEqual({
      aex: "1e-11",
      alpha: "0.02",
      dind: "",
      dbulk: "",
      materialName: "Material 1",
      materialRef: "mat-1",
      ms: "800000",
    });
    expect(materialParametersDraftKey("mat-1", resource)).toContain(
      "Material 1",
    );
  });

  it("builds the material patch for per-object magnetic parameters", () => {
    expect(
      buildMaterialParametersPatch({
        aex: "1e-11",
        alpha: "0.03",
        dind: "",
        dbulk: "",
        materialName: "Free layer",
        materialRef: "mat-1",
        ms: "8e5",
      }),
    ).toEqual({
      patch: {
        name: "Free layer",
        properties: {
          Aex: 1e-11,
          Dind: null,
          Dbulk: null,
          Ms: 8e5,
          alpha: 0.03,
        },
      },
    });
  });

  it("rejects non-numeric magnetic parameter edits", () => {
    expect(
      buildMaterialParametersPatch({
        aex: "bad",
        alpha: "0.03",
        dind: "",
        dbulk: "",
        materialName: "Free layer",
        materialRef: "mat-1",
        ms: "8e5",
      }),
    ).toEqual({ error: "Aex must be a finite SI value." });
  });
});
