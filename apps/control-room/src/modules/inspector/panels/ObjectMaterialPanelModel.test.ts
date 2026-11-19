import { describe, expect, it, vi } from "vitest";

import {
  assignedMaterialParametersDraft,
  buildCreateMaterialDraft,
  buildMaterialAssignmentPatch,
  buildMaterialParametersPatch,
  buildUniaxialAnisotropyPatch,
  createMaterialThenAssign,
  createMaterialAssetThenAssign,
  materialAssetFromLibraryEntry,
  independentMaterialAsset,
  magneticParameterMaterialResourceFromSceneResource,
  MaterialAssignmentAfterCreateError,
  magneticParametersDraftFromResource,
  magneticParametersDraftDirty,
  materialAssignmentDraftFromRef,
  materialParametersDraftKey,
  normalizeMaterialRef,
} from "./ObjectMaterialPanelModel";

describe("ObjectMaterialPanelModel", () => {
  it("uses all parameters from the assignment ACK, not an empty pre-assignment draft", () => {
    const acknowledged = {
      revision: 23,
      materials: [{
        id: "mat:waveguide",
        name: "Waveguide",
        properties: { Aex: 1.3e-11, Ms: 8e5, alpha: 0.02, Dind: null, Dbulk: null },
      }],
    };
    const draft = assignedMaterialParametersDraft("mat:waveguide", acknowledged);
    expect(buildMaterialParametersPatch(draft)).toEqual({
      patch: { name: "Waveguide", properties: acknowledged.materials[0].properties },
    });
    expect(assignedMaterialParametersDraft("mat:waveguide", {
      ...acknowledged,
      revision: 25,
      materials: [{ ...acknowledged.materials[0], properties: { Aex: 2e-11, Ms: 9e5, alpha: 0.03 } }],
    })).toMatchObject({ aex: "2e-11", ms: "900000", alpha: "0.03" });
    expect(() => assignedMaterialParametersDraft("mat:waveguide", { materials: [] }))
      .toThrow("missing from the acknowledged scene");
  });

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
      aex: "-1e-11",
      alpha: "0.02",
      anisotropyAxis: ["0", "0", "1"],
      ku1: "",
      materialId: "mat:bad",
      name: "Bad",
      ms: "1e6",
    })).toEqual({ error: "Aex must be zero or greater." });
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


describe("material database assignment", () => {
  const entry = {
    id: "custom:sample", revision: 7, kind: "modified" as const,
    name: "Measured film", summary: "Measured sample",
    properties: { Ms: 900000, Aex: 1.3e-11, alpha: 0, Dind: -0.001, Dbulk: null },
    references: [{ label: "Sample", citation: "Film A" }, { url: "https://example.org/method" }],
    source: {
      catalog_id: "builtin:permalloy", catalog_revision: 1, name: "Permalloy", kind: "builtin" as const,
      properties: { Ms: 800000, Aex: 1.3e-11, alpha: 0.01, Dind: null, Dbulk: null }, references: [],
    },
  };

  it("pins the selected entry revision and all references with a fresh immutable identity", () => {
    const first = materialAssetFromLibraryEntry(entry);
    const second = materialAssetFromLibraryEntry(entry);
    expect(first.materialId).toMatch(/^mat:[0-9a-f-]{36}$/);
    expect(second.materialId).not.toBe(first.materialId);
    expect(first.source).toEqual({
      catalog_id: entry.id, catalog_revision: entry.revision,
      name: entry.name, kind: entry.kind, properties: entry.properties, references: entry.references,
    });
    expect(first.source?.catalog_id).not.toBe(entry.source.catalog_id);
    expect(first.properties).not.toBe(entry.properties);
    expect(first.references).toEqual(entry.references);
    expect(first.references).not.toBe(entry.references);
    expect(first.source?.properties).not.toBe(first.properties);
  });

  it("creates and assigns atomically with the scoped base revision and no second write", async () => {
    const asset = materialAssetFromLibraryEntry(entry);
    const scene = { revision: 22, objects: [{ id: "body", material_ref: asset.materialId }], materials: [] };
    const created = { committed_scene: scene, scene_revision: 22, transaction_kind: "create_material" };
    const api = { model: { createMaterial: vi.fn(async () => created), patchObject: vi.fn() } };
    const result = await createMaterialAssetThenAssign(api, "body", asset, 21, () => true, "session=A");
    expect(api.model.createMaterial).toHaveBeenCalledOnce();
    expect(api.model.createMaterial).toHaveBeenCalledWith(
      asset.materialId, asset.name, asset.properties, entry.references,
      { baseRevision: 21, sessionScopeKey: "session=A" },
      { source: asset.source, assignToObjectId: "body" },
    );
    expect(api.model.patchObject).not.toHaveBeenCalled();
    expect(result).toEqual({ assigned: scene, created, deferredAnisotropy: null, materialId: asset.materialId });
  });

  it("keeps incomplete coefficients null instead of bypassing model readiness with defaults", async () => {
    const asset = materialAssetFromLibraryEntry({ ...entry, properties: { ...entry.properties, Ms: null, Aex: null } });
    const api = { model: {
      createMaterial: vi.fn(async () => ({ committed_scene: { revision: 2 }, scene_revision: 2 })),
      patchObject: vi.fn(),
    } };
    await createMaterialAssetThenAssign(api, "body", asset, 1, () => true);
    expect(api.model.createMaterial).toHaveBeenCalledWith(
      asset.materialId, asset.name, expect.objectContaining({ Ms: null, Aex: null, alpha: 0 }),
      asset.references, { baseRevision: 1 }, { source: asset.source, assignToObjectId: "body" },
    );
    expect(api.model.patchObject).not.toHaveBeenCalled();
  });

  it("does not issue a stale scoped request or retry a rejected atomic create", async () => {
    const api = { model: { createMaterial: vi.fn().mockRejectedValue(new Error("revision conflict")), patchObject: vi.fn() } };
    const asset = materialAssetFromLibraryEntry(entry);
    await expect(createMaterialAssetThenAssign(api, "body", asset, 1, () => false)).rejects.toThrow("scope");
    expect(api.model.createMaterial).not.toHaveBeenCalled();
    await expect(createMaterialAssetThenAssign(api, "body", asset, 1, () => true)).rejects.toThrow("revision conflict");
    expect(api.model.createMaterial).toHaveBeenCalledOnce();
    expect(api.model.patchObject).not.toHaveBeenCalled();
  });

  it("copies a scene material independently while retaining its existing source baseline", () => {
    const material = { ...entry, id: "mat:shared", scene_revision: 10 };
    const copy = independentMaterialAsset(material);
    expect(copy.materialId).not.toBe(material.id);
    expect(copy.properties).toEqual(material.properties);
    expect(copy.references).toEqual(material.references);
    expect(copy.source).toEqual(material.source);
    expect(copy.source?.catalog_id).toBe("builtin:permalloy");
    expect(copy.source).not.toBe(material.source);
  });

  it("keeps source and references from the committed scene while the material resource loads", () => {
    const scene = { revision: 12, materials: [{ ...entry, id: "mat:copy" }] };
    const resource = magneticParameterMaterialResourceFromSceneResource("mat:copy", scene);
    expect(resource?.source).toEqual(entry.source);
    expect(resource?.references).toEqual(entry.references);
    expect(resource?.scene_revision).toBe(12);
  });

  it("accepts zero exchange in manual creation and requires explicit Ms and Aex", () => {
    const draft = {
      materialId: "mat:new", name: "New", ms: "8e5", aex: "0", alpha: "0.01",
      ku1: "", anisotropyAxis: ["0", "0", "1"] as const,
    };
    expect(buildCreateMaterialDraft(draft)).toMatchObject({ value: { properties: { Aex: 0 } } });
    expect(buildCreateMaterialDraft({ ...draft, aex: "-1e-11" })).toHaveProperty("error");
    expect(buildCreateMaterialDraft({ ...draft, aex: "" })).toHaveProperty("error");
    expect(buildCreateMaterialDraft({ ...draft, ms: "" })).toHaveProperty("error");
  });

  it("rejects blank or negative damping while accepting explicit zero in create and direct edits", () => {
    const draft = {
      materialId: "mat:new", name: "New", ms: "8e5", aex: "1.3e-11", alpha: "",
      ku1: "", anisotropyAxis: ["0", "0", "1"] as const,
    };
    expect(buildCreateMaterialDraft(draft)).toEqual({ error: "alpha is required." });
    expect(buildCreateMaterialDraft({ ...draft, alpha: "0" })).toMatchObject({ value: { properties: { alpha: 0 } } });
    const direct = { materialRef: "mat:new", materialName: "New", ms: "8e5", aex: "1.3e-11", alpha: "", dind: "", dbulk: "" };
    expect(buildMaterialParametersPatch(direct)).toEqual({ error: "alpha is required." });
    expect(buildMaterialParametersPatch({ ...direct, alpha: "-0.01" })).toHaveProperty("error");
    expect(buildMaterialParametersPatch({ ...direct, alpha: "0" })).toMatchObject({ patch: { properties: { alpha: 0 } } });
  });
});
