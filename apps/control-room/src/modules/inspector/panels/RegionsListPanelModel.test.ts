import { describe, expect, it } from "vitest";

import {
  buildNewRegionPayload,
  defaultNewRegionDraft,
  findRegionIdByName,
  findLastRegionSelection,
  regionNodeId,
  regionsNodeId,
  resolveRegionsListPanelModel,
  validateNewRegionDraft,
} from "./RegionsListPanelModel";

describe("RegionsListPanelModel", () => {
  it("resolves authored regions for the selected object sorted by priority", () => {
    const model = resolveRegionsListPanelModel(
      {
        kind: "object.regions",
        label: "Regions",
        moduleSource: "explorer",
        nodeId: "model:object:film:regions",
        objectId: "film",
        ref: {
          kind: "object.regions",
          nodeId: "model:object:film:regions",
          objectId: "film",
          type: "scene-object",
          visualizationTargetId: "object:film",
        },
      },
      {
        objects: [
          {
            geometry: {
              bounds_max: [100e-9, 50e-9, 10e-9],
              bounds_min: [-100e-9, -50e-9, -10e-9],
              geometry_kind: "Box",
              geometry_params: { size: [400e-9, 200e-9, 40e-9] },
            },
            id: "film",
            name: "Film",
          },
        ],
        revision: 12,
      },
      {
        geometry_realization_revision: 0,
        regions: [
          {
            bounds_max: [1, 1, 1],
            bounds_min: [0, 0, 0],
            enabled: true,
            interaction_refs: [],
            material_ref: "mat-film",
            mesh_part_ids: [],
            name: "Low",
            owner_object_id: "film",
            priority: 1,
            region_id: "reg-low",
            shape: { kind: "box" } as never,
            source: "authored_object_region",
            source_body_ids: [],
            source_object_ids: ["film"],
          },
          {
            bounds_max: [1, 1, 1],
            bounds_min: [0, 0, 0],
            enabled: false,
            interaction_refs: [],
            material_ref: "mat-film",
            mesh_part_ids: [],
            name: "High",
            owner_object_id: "film",
            priority: 8,
            realization_policy: "conformal",
            realization_status: "authored_pending_realization",
            region_id: "reg-high",
            shape: { kind: "cylinder" } as never,
            source: "authored_object_region",
            source_body_ids: [],
            source_object_ids: ["film"],
          },
          {
            bounds_max: [1, 1, 1],
            bounds_min: [0, 0, 0],
            enabled: true,
            interaction_refs: [],
            material_ref: "mat-other",
            mesh_part_ids: [],
            name: "Other",
            owner_object_id: "other",
            region_id: "reg-other",
            source: "authored_object_region",
            source_body_ids: [],
            source_object_ids: ["other"],
          },
        ],
        scene_revision: 12,
      },
      {
        diagnostics: [
          {
            capability_gate: "regions.material_override",
            code: "region.material.conflict",
            diagnostic_id: "diag-high-conflict",
            message: "Region material override conflicts with another region.",
            owner_object_id: "film",
            realization_status: "blocked",
            region_id: "reg-high",
            severity: "error",
          },
          {
            code: "region.mesh.deferred",
            diagnostic_id: "diag-low-warning",
            message: "Region mesh policy is deferred by the selected backend.",
            owner_object_id: "film",
            region_id: "reg-low",
            severity: "warning",
          },
          {
            code: "region.material.conflict",
            diagnostic_id: "diag-other-conflict",
            message: "Other object conflict.",
            owner_object_id: "other",
            region_id: "reg-other",
            severity: "error",
          },
        ],
        scene_revision: 12,
      },
    );

    expect(model).toMatchObject({
      mode: "committed",
      objectId: "film",
      objectLabel: "Film",
      ownerBounds: {
        center: [0, 0, 0],
        size: [200e-9, 100e-9, 20e-9],
      },
      revision: 12,
    });
    expect(model.items.map((item) => item.regionId)).toEqual([
      "reg-high",
      "reg-low",
    ]);
    expect(model.items[0]).toMatchObject({
      colorIndex: 0,
      conflictCount: 1,
      diagnosticCount: 1,
      enabled: false,
      errorCount: 1,
      priority: 8,
      realizationPolicy: "conformal",
      realizationStatus: "authored_pending_realization",
      shapeKind: "cylinder",
      warningCount: 0,
    });
    expect(model.items[1]).toMatchObject({
      colorIndex: 1,
      conflictCount: 0,
      diagnosticCount: 1,
      errorCount: 0,
      priority: 1,
      shapeKind: "box",
      warningCount: 1,
    });
    expect(model).toMatchObject({
      conflictCount: 1,
      diagnosticCount: 2,
      errorCount: 1,
      warningCount: 1,
    });
  });

  it("builds default create payloads and node ids", () => {
    expect(defaultNewRegionDraft()).toEqual({
      name: "",
      priority: 0,
      shapeKind: "box",
    });
    expect(
      buildNewRegionPayload({
        name: " Core ",
        priority: 7,
        shapeKind: "sphere",
      }, {
        center: [10e-9, 0, 0],
        size: [200e-9, 100e-9, 20e-9],
      }),
    ).toEqual({
      region_id: "",
      enabled: true,
      frame: "object",
      name: "Core",
      priority: 7,
      realization_policy: "inherit",
      shape: {
        center: [10e-9, 0, 0],
        kind: "sphere",
        radius: 5e-9,
      },
    });
    expect(regionNodeId("film", "reg-core")).toBe(
      "model:object:film:regions:reg-core",
    );
    expect(regionsNodeId("film")).toBe("model:object:film:regions");
  });

  it("validates new region drafts before create transactions", () => {
    expect(
      validateNewRegionDraft({
        name: "core",
        priority: 0,
        shapeKind: "box",
      }),
    ).toEqual([]);
    expect(
      validateNewRegionDraft({
        name: "  ",
        priority: 0,
        shapeKind: "box",
      }),
    ).toContain("Region name is required.");
    expect(
      validateNewRegionDraft({
        name: "core",
        priority: 1.5,
        shapeKind: "box",
      }),
    ).toContain("Region priority must be an integer.");
    expect(
      validateNewRegionDraft({
        name: "core",
        priority: 0,
        shapeKind: "torus" as never,
      }),
    ).toContain("Region shape must be box, cylinder, or sphere.");
  });

  it("uses parent geometry params to keep default cylinder regions inside the owner", () => {
    const model = resolveRegionsListPanelModel(
      {
        kind: "object.regions",
        label: "Regions",
        moduleSource: "explorer",
        nodeId: "model:object:film:regions",
        objectId: "film",
        ref: {
          kind: "object.regions",
          nodeId: "model:object:film:regions",
          objectId: "film",
          type: "scene-object",
          visualizationTargetId: "object:film",
        },
      },
      {
        objects: [
          {
            geometry: {
              geometry_kind: "Box",
              geometry_params: { size: [200e-9, 100e-9, 20e-9] },
            },
            id: "film",
            name: "Film",
          },
        ],
        revision: 12,
      },
      { geometry_realization_revision: 0, regions: [], scene_revision: 12 },
    );

    expect(
      buildNewRegionPayload(
        { name: " Core ", priority: 7, shapeKind: "cylinder" },
        model.ownerBounds,
      ),
    ).toMatchObject({
      realization_policy: "inherit",
      shape: {
        axis: [0, 0, 1],
        center: [0, 0, 0],
        height: 10e-9,
        kind: "cylinder",
        radius: 25e-9,
      },
    });
  });

  it("finds a newly created region id by unique name in a scene response", () => {
    expect(
      findRegionIdByName(
        {
          objects: [
            {
              id: "film",
              regions: [
                { name: "Core", region_id: "reg-core" } as never,
                { name: "Edge", region_id: "reg-edge" } as never,
              ],
            },
          ],
        },
        "film",
        " Core ",
      ),
    ).toBe("reg-core");

    expect(
      findRegionIdByName(
        {
          objects: [
            {
              id: "film",
              regions: [
                { name: "Core", region_id: "reg-a" } as never,
                { name: "Core", region_id: "reg-b" } as never,
              ],
            },
          ],
        },
        "film",
        "Core",
      ),
    ).toBeNull();
  });

  it("finds the last non-source region selection after duplication", () => {
    expect(
      findLastRegionSelection(
        {
          objects: [
            {
              id: "film",
              regions: [
                { name: "Core", region_id: "film:core" } as never,
                { name: "Edge", region_id: "film:edge" } as never,
                { name: "Core copy", region_id: "film:core_copy" } as never,
              ],
            },
          ],
        },
        "film",
        "film:core",
      ),
    ).toEqual({ name: "Core copy", regionId: "film:core_copy" });

    expect(findLastRegionSelection({ objects: [] }, "film", "film:core")).toBeNull();
  });
});
