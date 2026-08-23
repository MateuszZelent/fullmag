import { describe, expect, it, vi } from "vitest";

import {
  buildCreateMaterialDraft,
  buildMaterialAssignmentPatch,
  buildMaterialParametersPatch,
  buildUniaxialAnisotropyPatch,
  createMaterialThenAssign,
  MaterialAssignmentAfterCreateError,
  magneticParametersDraftFromResource,
  magneticParametersDraftDirty,
  materialAssignmentDraftFromRef,
  materialParametersDraftKey,
  normalizeMaterialRef,
} from "./ObjectMaterialPanelModel";

describe("ObjectMaterialPanelModel", () => {
  it("validates canonical SI values for a new material and optional anisotropy", () => {
    expect(buildCreateMaterialDraft({
      aex: "1.3e-11",
      alpha: "0.02",
      anisotropyAxis: ["0", "1", "0"],
      ku1: "4e5",
      materialId: "mat:cofeb",
      name: "CoFeB",
      ms: "1.1e6",
    })).toEqual({
      value: {
        anisotropy: { axis: [0, 1, 0], ku1: 4e5 },
        materialId: "mat:cofeb",
        name: "CoFeB",
        properties: { Aex: 1.3e-11, Dbulk: null, Dind: null, Ms: 1.1e6, alpha: 0.02 },
      },
    });

    expect(buildCreateMaterialDraft({
      aex: "0",
      alpha: "0.02",
      anisotropyAxis: ["0", "0", "1"],
      ku1: "",
      materialId: "mat:bad",
      name: "Bad",
      ms: "1e6",
    })).toEqual({ error: "A must be greater than 0 J/m." });
    expect(buildUniaxialAnisotropyPatch("1e5", ["0", "0", "0"])).toEqual({
      error: "Anisotropy axis must be non-zero.",
    });
  });

  it("creates a material and assigns its immutable id using the authoritative first ACK revision", async () => {
    const created = {
      committed_scene: { materials: [{ id: "mat:cofeb", name: "CoFeB", properties: {} }], revision: 22 },
      scene_revision: 22,
      transaction_kind: "create_material",
    };
    const assigned = { objects: [{ id: "object-7", material_ref: "mat:cofeb" }], revision: 23 };
    const api = {
      model: {
        createMaterial: vi.fn(async () => created),
        patchObject: vi.fn(async () => assigned),
      },
    };
    const onMaterialCreated = vi.fn();

    const result = await createMaterialThenAssign(api, "object-7", {
      aex: "1.3e-11",
      alpha: "0.02",
      anisotropyAxis: ["0", "0", "1"],
      ku1: "",
      materialId: "mat:cofeb",
      name: "CoFeB",
      ms: "1.1e6",
    }, 21, onMaterialCreated);

    expect(api.model.createMaterial).toHaveBeenCalledWith(
      "mat:cofeb",
      "CoFeB",
      expect.objectContaining({ Aex: 1.3e-11, Ms: 1.1e6 }),
      [],
      { baseRevision: 21 },
    );
    expect(onMaterialCreated).toHaveBeenCalledWith(created);
    expect(api.model.patchObject).toHaveBeenCalledWith("object-7", {
      base_revision: 22,
      material_ref: "mat:cofeb",
    });
    expect(result).toEqual({
      assigned,
      created,
      deferredAnisotropy: null,
      materialId: "mat:cofeb",
    });
  });

  it("keeps the created material and exposes an explicit latest-revision assignment retry", async () => {
    const conflict = new Error("revision conflict");
    const created = {
      committed_scene: { materials: [{ id: "mat:cofeb", name: "CoFeB", properties: {} }], revision: 22 },
      scene_revision: 22,
      transaction_kind: "create_material",
    };
    const api = {
      model: {
        createMaterial: vi.fn(async () => created),
        patchObject: vi.fn().mockRejectedValueOnce(conflict).mockResolvedValueOnce({ revision: 25 }),
      },
    };

    let failure: unknown;
    try {
      await createMaterialThenAssign(api, "object-7", {
        aex: "1e-11",
        alpha: "0.01",
        anisotropyAxis: ["0", "1", "0"],
        ku1: "4e5",
        materialId: "mat:cofeb",
        name: "CoFeB",
        ms: "8e5",
      }, 21);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(MaterialAssignmentAfterCreateError);
    expect(failure).toMatchObject({
      assignmentBaseRevision: 22,
      deferredAnisotropy: { axis: [0, 1, 0], ku1: 4e5 },
      materialId: "mat:cofeb",
      objectId: "object-7",
    });
    await (failure as MaterialAssignmentAfterCreateError).retry(api, 24);
    expect(api.model.createMaterial).toHaveBeenCalledOnce();
    expect(api.model.patchObject).toHaveBeenLastCalledWith("object-7", {
      base_revision: 24,
      material_ref: "mat:cofeb",
    });
  });

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
      scene_revision: 12,
    };

    const draft = magneticParametersDraftFromResource("mat-1", resource);
    expect(draft).toEqual({
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
    expect(magneticParametersDraftDirty({ ...draft, ms: "8e5" }, draft)).toBe(
      false,
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
