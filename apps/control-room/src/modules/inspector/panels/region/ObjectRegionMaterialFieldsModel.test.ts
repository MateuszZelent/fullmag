import { describe, expect, it } from "vitest";

import {
  materialFieldRealizationRows,
  isEditableMaterialField,
  materialFieldDraftFromAssignment,
  materialFieldFromDraft,
  sceneObjectMaterialFields,
  unitForMaterialParameter,
  type MaterialFieldDraft,
  type SceneMaterialParameterAssignment,
} from "./ObjectRegionMaterialFieldsModel";

describe("ObjectRegionMaterialFieldsModel", () => {
  it("round-trips linear material fields through the scene assignment contract", () => {
    const assignment: SceneMaterialParameterAssignment = {
      assignment_id: "field:linear",
      conflict_policy: "higher_priority_wins",
      owner_object: "permalloy_box",
      parameter: "ms",
      priority: 7,
      region_id: "hole_shell",
      value: {
        base: 810000,
        frame: "object",
        gradient: [1, 2, 3],
        kind: "linear",
        unit: "A/m",
      },
    };

    const draft = materialFieldDraftFromAssignment(assignment);

    expect(draft).toMatchObject({
      assignmentId: "field:linear",
      base: 810000,
      conflictPolicy: "higher_priority_wins",
      frame: "object",
      gradient: [1, 2, 3],
      kind: "linear",
      parameter: "ms",
      priority: 7,
      unit: "A/m",
    });
    expect(materialFieldFromDraft(draft as MaterialFieldDraft, {
      objectId: "permalloy_box",
      regionId: "hole_shell",
    })).toEqual(assignment);
  });

  it("builds realized field preview rows from the material-fields resource", () => {
    expect(
      materialFieldRealizationRows("field:linear", {
        fields: [
          {
            assignment_id: "field:linear",
            field: {
              base: 810000,
              frame: "object",
              gradient: [1, 2, 3],
              kind: "linear",
              unit: "A/m",
            },
            max: 820000,
            mean: 815000,
            min: 810000,
            owner_object_id: "permalloy_box",
            parameter: "ms",
            realization_status: "realized",
            sample_count: 64,
            source_region_id: "hole_shell",
            unit: "A/m",
            warnings: ["projected to nearest cell center"],
          },
        ],
        scene_revision: 12,
      }),
    ).toEqual([
      { label: "Realization", value: "realized" },
      { label: "Samples", value: "64" },
      { label: "Min", value: "810000 A/m" },
      { label: "Max", value: "820000 A/m" },
      { label: "Mean", value: "815000 A/m" },
      { label: "Warnings", value: "projected to nearest cell center" },
    ]);
  });

  it("serializes radial material fields with center, radius, and conflict policy", () => {
    const draft: MaterialFieldDraft = {
      assignmentId: "field:radial",
      base: 900000,
      center: [1e-9, 2e-9, 3e-9],
      conflictPolicy: "error",
      frame: "world",
      gradient: [0, 0, 0],
      inside: 900000,
      kind: "radial",
      outside: 760000,
      parameter: "ms",
      priority: 3.8,
      radius: 30e-9,
      scalar: 900000,
      unit: "A/m",
    };

    expect(materialFieldFromDraft(draft, {
      objectId: "permalloy_box",
      regionId: "hole_shell",
    })).toEqual({
      assignment_id: "field:radial",
      conflict_policy: "error",
      owner_object: "permalloy_box",
      parameter: "ms",
      priority: 3,
      region_id: "hole_shell",
      value: {
        center: [1e-9, 2e-9, 3e-9],
        frame: "world",
        inside: 900000,
        kind: "radial",
        outside: 760000,
        radius: 30e-9,
        unit: "A/m",
      },
    });
  });

  it("omits the FEM-only mesh-size conflict policy for an FDM field while preserving its physical value", () => {
    const draft: MaterialFieldDraft = {
      assignmentId: "field:fdm",
      base: 900000,
      center: [0, 0, 0],
      conflictPolicy: "min_mesh_size_wins",
      frame: "object",
      gradient: [0, 0, 0],
      inside: 900000,
      kind: "constant",
      outside: 900000,
      parameter: "ms",
      priority: 3,
      radius: 30e-9,
      scalar: 900000,
      unit: "A/m",
    };

    const assignment = materialFieldFromDraft(
      draft,
      { objectId: "permalloy_box", regionId: "hole_shell" },
      { meshPolicyLane: "fdm" },
    );

    expect(assignment).not.toHaveProperty("conflict_policy");
    expect(assignment.value).toEqual({
      kind: "constant",
      unit: "A/m",
      value: 900000,
    });
  });

  it("preserves sampled fields as unsupported instead of trying to edit them", () => {
    const assignment: SceneMaterialParameterAssignment = {
      assignment_id: "field:sampled",
      owner_object: "permalloy_box",
      parameter: "ms",
      region_id: "hole_shell",
      value: {
        asset_id: "asset:field",
        component_count: 1,
        kind: "sampled",
        location: "cell",
        unit: "A/m",
      },
    };

    expect(isEditableMaterialField(assignment)).toBe(false);
    expect(materialFieldDraftFromAssignment(assignment)).toBeNull();
  });

  it("extracts material fields for the selected object only", () => {
    const fields = sceneObjectMaterialFields(
      {
        objects: [
          {
            id: "permalloy_box",
            material_parameter_fields: [
              {
                assignment_id: "field:constant",
                owner_object: "permalloy_box",
                parameter: "aex",
                region_id: null,
                value: { kind: "constant", unit: "J/m", value: 1.3e-11 },
              },
            ],
          },
          {
            id: "airbox",
            material_parameter_fields: [
              {
                assignment_id: "field:airbox",
                owner_object: "airbox",
                parameter: "ms",
                region_id: null,
                value: { kind: "constant", unit: "A/m", value: 0 },
              },
            ],
          },
        ],
      },
      "permalloy_box",
    );

    expect(fields).toHaveLength(1);
    expect(fields[0]?.assignment_id).toBe("field:constant");
  });

  it("uses expected SI units for common magnetic parameters", () => {
    expect(unitForMaterialParameter("ms")).toBe("A/m");
    expect(unitForMaterialParameter("aex")).toBe("J/m");
    expect(unitForMaterialParameter("alpha")).toBe("");
    expect(unitForMaterialParameter("ku1")).toBe("J/m^3");
    expect(unitForMaterialParameter("dind")).toBe("J/m^2");
  });
});
