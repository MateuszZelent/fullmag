import { describe, expect, it } from "vitest";

import type { CouplingListResource } from "@/kernel/api/apiTypes";

import {
  buildObjectRegionPatch,
  clampObjectRegionDraftShapeToOwnerBounds,
  formatRegionPhysicalScalar,
  objectRegionDraftFromModel,
  objectRegionDraftKey,
  parseRegionPhysicalScalar,
  resolveRegionCouplingDependencies,
  resolveObjectRegionPanelModel,
  validateObjectRegionDraft,
} from "./ObjectRegionsPanelModel";

describe("ObjectRegionsPanelModel", () => {
  it("summarizes active coupling dependencies for a selected object region", () => {
    const couplings: CouplingListResource = {
      couplings: [
        {
          blocker_reason: "runtime unavailable",
          capability_policy: "require_runtime",
          coupling_id: "exchange:core-shell",
          coupling_kind: "exchange",
          enabled: true,
          params: { kind: "exchange", mode: "harmonic_mean", scale: 1.0 } as never,
          realization_status: "authored_pending_realization",
          source: { kind: "region", object: "film", region_id: "film:core" } as never,
          source_resolution: {
            object_id: "film",
            region_id: "film:core",
            status: "authored_endpoint_valid",
          },
          target: { kind: "region", object: "film", region_id: "film:shell" } as never,
          target_resolution: {
            object_id: "film",
            region_id: "film:shell",
            status: "authored_endpoint_valid",
          },
        },
        {
          coupling_id: "exchange:disabled",
          coupling_kind: "exchange",
          enabled: false,
          params: { kind: "exchange", mode: "harmonic_mean", scale: 1.0 } as never,
          source: { kind: "region", object: "film", region_id: "film:core" } as never,
          source_resolution: {
            object_id: "film",
            region_id: "film:core",
            status: "authored_endpoint_valid",
          },
          target: { kind: "object", object: "film" } as never,
          target_resolution: {
            object_id: "film",
            status: "authored_endpoint_valid",
          },
        },
      ],
      scene_revision: 4,
    };

    expect(
      resolveRegionCouplingDependencies("film", "film:core", couplings),
    ).toEqual([
      {
        couplingId: "exchange:core-shell",
        endpointRole: "source",
        kind: "exchange",
        status: "authored_pending_realization",
      },
    ]);
  });

  it("resolves object-derived regions from scene and region resources", () => {
    const model = resolveObjectRegionPanelModel(
      {
        kind: "object.regions",
        label: "Regions",
        moduleSource: "explorer",
        nodeId: "model:object:free-layer:regions",
        objectId: "free-layer",
        ref: {
          kind: "object.regions",
          nodeId: "model:object:free-layer:regions",
          objectId: "free-layer",
          type: "scene-object",
          visualizationTargetId: "object:free-layer",
        },
      },
      {
        objects: [
          {
            id: "free-layer",
            magnetization_ref: "mag-1",
            material_ref: "mat-1",
            name: "Free layer",
            region_name: "free",
            visible: true,
          },
        ],
        revision: 7,
      },
      {
        geometry_realization_revision: 9,
        regions: [
          {
            bounds_max: [1, 1, 1],
            bounds_min: [0, 0, 0],
            enabled: false,
            interaction_refs: ["exchange"],
            magnetization_ref: "mag-1",
            material_ref: "mat-1",
            mesh_part_ids: [],
            name: "free",
            region_id: "region:free-layer",
            source: "object",
            source_body_ids: ["body:free-layer"],
            source_object_ids: ["free-layer"],
          },
        ],
        scene_revision: 7,
      },
    );

    expect(model).toMatchObject({
      enabled: false,
      magnetizationRef: "mag-1",
      materialRef: "mat-1",
      mode: "committed",
      objectId: "free-layer",
      regionId: "region:free-layer",
      regionName: "free",
      revision: 7,
      source: "object",
    });
    expect(objectRegionDraftFromModel(model)).toEqual({
      enabled: false,
      frame: "object",
      materialOverrides: [],
      meshPolicy: {
        enabled: false,
        maximumElementSize: 10e-9,
        minimumElementSize: 1e-9,
        order: 1,
        transitionDistance: 50e-9,
      },
      name: "free",
      ownerBounds: null,
      priority: 0,
      realizationPolicy: "inherit",
      shape: {
        axis: [0, 0, 1],
        center: [0, 0, 0],
        height: 100e-9,
        kind: "box",
        radius: 50e-9,
        size: [100e-9, 100e-9, 100e-9],
      },
    });
    expect(objectRegionDraftKey(model)).toContain("region:free-layer");
  });

  it("builds v2 region patch payloads", () => {
    expect(
      buildObjectRegionPatch({
        enabled: true,
        frame: "object",
        materialOverrides: [
          {
            conflictPolicy: "higher_priority_wins",
            parameter: "ms",
            priority: 4,
            unit: "A/m",
            value: 760e3,
          },
        ],
        meshPolicy: {
          enabled: true,
          maximumElementSize: 2e-9,
          minimumElementSize: 1e-9,
          order: 1,
          transitionDistance: 50e-9,
        },
        name: " free ",
        ownerBounds: null,
        priority: 4,
        realizationPolicy: "conformal",
        shape: {
          axis: [0, 0, 1],
          center: [1e-9, 2e-9, 0],
          height: 5e-9,
          kind: "cylinder",
          radius: 20e-9,
          size: [100e-9, 100e-9, 5e-9],
        },
      }),
    ).toEqual({
      enabled: true,
      frame: "object",
      material_overrides: [
        {
          conflict_policy: "higher_priority_wins",
          parameter: "ms",
          priority: 4,
          value: {
            kind: "constant",
            unit: "A/m",
            value: 760e3,
          },
        },
      ],
      mesh_policy: {
        maximum_element_size: 2e-9,
        minimum_element_size: 1e-9,
        order: 1,
        transition_distance: 50e-9,
      },
      name: "free",
      priority: 4,
      realization_policy: "conformal",
      shape: {
        axis: [0, 0, 1],
        center: [1e-9, 2e-9, 0],
        height: 5e-9,
        kind: "cylinder",
        radius: 20e-9,
      },
    });
  });

  it("clamps edited region shapes to the parent object bounds", () => {
    expect(
      clampObjectRegionDraftShapeToOwnerBounds(
        {
          axis: [0, 0, 1],
          center: [1e-6, 0, 0],
          height: 100e-9,
          kind: "box",
          radius: 80e-9,
          size: [200e-9, 200e-9, 100e-9],
        },
        {
          center: [0, 0, 0],
          size: [100e-9, 50e-9, 10e-9],
        },
      ),
    ).toMatchObject({
      center: [0, 0, 0],
      size: [100e-9, 50e-9, 10e-9],
    });

    expect(
      clampObjectRegionDraftShapeToOwnerBounds(
        {
          axis: [0, 0, 1],
          center: [1e-6, 0, 0],
          height: 100e-9,
          kind: "sphere",
          radius: 80e-9,
          size: [200e-9, 200e-9, 100e-9],
        },
        {
          center: [0, 0, 0],
          size: [100e-9, 50e-9, 10e-9],
        },
      ),
    ).toMatchObject({
      center: [45e-9, 0, 0],
      radius: 5e-9,
    });

    expect(
      clampObjectRegionDraftShapeToOwnerBounds(
        {
          axis: [0, 0, 1],
          center: [1e-6, 0, 0],
          height: 100e-9,
          kind: "cylinder",
          radius: 80e-9,
          size: [200e-9, 200e-9, 100e-9],
        },
        {
          center: [0, 0, 0],
          size: [100e-9, 50e-9, 10e-9],
        },
      ),
    ).toMatchObject({
      center: [25e-9, 0, 0],
      height: 10e-9,
      radius: 25e-9,
    });

    expect(
      buildObjectRegionPatch({
        enabled: true,
        frame: "object",
        materialOverrides: [],
        meshPolicy: {
          enabled: false,
          maximumElementSize: 10e-9,
          minimumElementSize: 1e-9,
          order: 1,
          transitionDistance: 50e-9,
        },
        name: "oversized",
        ownerBounds: {
          center: [0, 0, 0],
          size: [100e-9, 50e-9, 10e-9],
        },
        priority: 0,
        realizationPolicy: "inherit",
        shape: {
          axis: [0, 0, 1],
          center: [1e-6, 0, 0],
          height: 100e-9,
          kind: "cylinder",
          radius: 80e-9,
          size: [200e-9, 200e-9, 100e-9],
        },
      })["shape"],
    ).toEqual({
      axis: [0, 0, 1],
      center: [25e-9, 0, 0],
      height: 10e-9,
      kind: "cylinder",
      radius: 25e-9,
    });
  });

  it("clamps an oblique cylinder by its full axis-aligned extent", () => {
    const clamped = clampObjectRegionDraftShapeToOwnerBounds(
      {
        axis: [1, 1, 0],
        center: [0, 0, 0],
        height: 2,
        kind: "cylinder",
        radius: 1,
        size: [2, 2, 2],
      },
      {
        center: [0, 0, 0],
        size: [2, 2, 2],
      },
    );

    expect(clamped.height).toBeCloseTo(2);
    expect(clamped.radius).toBeCloseTo(Math.SQRT2 - 1);
  });

  it("does not clamp world-frame coordinates against object-local bounds", () => {
    const patch = buildObjectRegionPatch({
      enabled: true,
      frame: "world",
      materialOverrides: [],
      meshPolicy: {
        enabled: false,
        maximumElementSize: 10e-9,
        minimumElementSize: 1e-9,
        order: 1,
        transitionDistance: 50e-9,
      },
      name: "world region",
      ownerBounds: {
        center: [0, 0, 0],
        size: [1, 1, 1],
      },
      priority: 0,
      realizationPolicy: "inherit",
      shape: {
        axis: [0, 0, 1],
        center: [10, 0, 0],
        height: 2,
        kind: "sphere",
        radius: 2,
        size: [2, 2, 2],
      },
    });

    expect(patch.shape).toEqual({
      center: [10, 0, 0],
      kind: "sphere",
      radius: 2,
    });
  });

  it("formats and parses SI-scale physical values with scientific notation", () => {
    expect(formatRegionPhysicalScalar(2e-6)).toBe("2e-6");
    expect(formatRegionPhysicalScalar(1.25e-11)).toBe("1.25e-11");
    expect(formatRegionPhysicalScalar(760e3)).toBe("760000");
    expect(parseRegionPhysicalScalar("1.5e-9")).toBe(1.5e-9);
    expect(parseRegionPhysicalScalar("1 nm")).toBe(1e-9);
    expect(parseRegionPhysicalScalar("2.5 um")).toBeCloseTo(2.5e-6);
    expect(parseRegionPhysicalScalar("800 kA/m")).toBe(800e3);
    expect(parseRegionPhysicalScalar("13 pJ/m")).toBeCloseTo(13e-12);
    expect(parseRegionPhysicalScalar("not-a-number")).toBeNull();
    expect(parseRegionPhysicalScalar("1 banana")).toBeNull();
  });

  it("validates region drafts before sending physical patches", () => {
    const validDraft = objectRegionDraftFromModel(
      resolveObjectRegionPanelModel(
        {
          kind: "object.region",
          label: "Core",
          moduleSource: "explorer",
          nodeId: "model:object:film:regions:reg-core",
          objectId: "film",
          ref: {
            kind: "object.region",
            nodeId: "model:object:film:regions:reg-core",
            objectId: "film",
            regionId: "reg-core",
            type: "scene-object",
            visualizationTargetId: "object:film",
          },
        },
        {
          objects: [{ id: "film", name: "Film" }],
          revision: 1,
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
              name: "Core",
              owner_object_id: "film",
              region_id: "reg-core",
              shape: { kind: "box", size: [10e-9, 10e-9, 2e-9] } as never,
              source: "authored_object_region",
              source_body_ids: [],
              source_object_ids: ["film"],
            },
          ],
          scene_revision: 1,
        },
      ),
    );

    expect(validateObjectRegionDraft(validDraft)).toEqual([]);
    expect(validateObjectRegionDraft({ ...validDraft, name: "  " })).toContain(
      "Region name is required.",
    );
    expect(
      validateObjectRegionDraft({ ...validDraft, priority: 1.5 }),
    ).toContain("Region priority must be an integer.");
    expect(
      validateObjectRegionDraft({
        ...validDraft,
        meshPolicy: {
          ...validDraft.meshPolicy,
          enabled: true,
          maximumElementSize: 1e-9,
          minimumElementSize: 2e-9,
        },
      }),
    ).toContain("Max element size must be greater than or equal to min element size.");
    expect(
      validateObjectRegionDraft({
        ...validDraft,
        meshPolicy: {
          ...validDraft.meshPolicy,
          enabled: true,
          order: 1.5,
        },
      }),
    ).toContain("Mesh order must be an integer at least 1.");
    expect(
      validateObjectRegionDraft({
        ...validDraft,
        shape: { ...validDraft.shape, kind: "sphere", radius: 0 },
      }),
    ).toContain("Radius must be greater than zero.");
    expect(
      validateObjectRegionDraft({
        ...validDraft,
        shape: {
          ...validDraft.shape,
          axis: [0, 0, 0],
          kind: "cylinder",
        },
      }),
    ).toContain("Axis must not be the zero vector.");
    expect(
      validateObjectRegionDraft({
        ...validDraft,
        materialOverrides: [
          {
            conflictPolicy: "error",
            parameter: "ms",
            priority: 1.5,
            unit: "A/m",
            value: 800e3,
          },
        ],
      }),
    ).toContain("ms override priority must be an integer.");
  });

  it("prefers the selected authored region and counts parameter fields", () => {
    const model = resolveObjectRegionPanelModel(
      {
        kind: "object.region",
        label: "Skyrmion core",
        moduleSource: "explorer",
        nodeId: "model:object:film:regions:reg-core",
        objectId: "film",
        ref: {
          kind: "object.region",
          nodeId: "model:object:film:regions:reg-core",
          objectId: "film",
          regionId: "reg-core",
          type: "scene-object",
          visualizationTargetId: "object:film",
        },
      },
      {
        objects: [
          {
            id: "film",
            magnetization_ref: "mag-film",
            material_ref: "mat-film",
            name: "Film",
            visible: true,
          },
        ],
        revision: 11,
      },
      {
        geometry_realization_revision: 0,
        regions: [
          {
            bounds_max: [1, 1, 1],
            bounds_min: [0, 0, 0],
            enabled: true,
            interaction_refs: [],
            magnetization_ref: "mag-core",
            material_overrides: [
              {
                conflict_policy: "error",
                parameter: "ms",
                priority: 8,
                value: {
                  kind: "constant",
                  value: 800000,
                },
              },
            ],
            material_ref: "mat-film",
            mesh_part_ids: [],
            name: "Skyrmion core",
            owner_object_id: "film",
            priority: 8,
            region_id: "reg-core",
            realization_policy: "conformal",
            realization_status: "authored_pending_realization",
            mesh_policy: {
              maximum_element_size: 1e-9,
              minimum_element_size: 0.5e-9,
              order: 1,
              transition_distance: 20e-9,
            } as never,
            shape: {
              center: [0, 0, 0],
              kind: "sphere",
              radius: 15e-9,
            } as never,
            source: "authored_object_region",
            source_body_ids: [],
            source_object_ids: ["film"],
            texture_override: {
              initial_magnetization: {
                kind: "uniform",
                value: [0, 0, 1],
              },
            } as never,
          },
        ],
        scene_revision: 11,
      },
      {
        fields: [
          {
            assignment_id: "field-ms-core",
            field: {},
            owner_object_id: "film",
            parameter: "ms",
            source_region_id: "reg-core",
          },
        ],
        scene_revision: 11,
      } as never,
    );

    expect(model).toMatchObject({
      effectiveMagnetizationRef: "mag-core",
      materialFieldCount: 1,
      materialOverrideCount: 1,
      materialOverrides: [
        {
          conflictPolicy: "error",
          parameter: "ms",
          priority: 8,
          unit: "A/m",
          value: 800000,
        },
      ],
      objectId: "film",
      priority: 8,
      realizationPolicy: "conformal",
      realizationStatus: "authored_pending_realization",
      regionId: "reg-core",
      regionMagnetizationRef: "mag-core",
      regionName: "Skyrmion core",
      shape: {
        center: [0, 0, 0],
        kind: "sphere",
        radius: 15e-9,
      },
      meshPolicy: {
        enabled: true,
        maximumElementSize: 1e-9,
        minimumElementSize: 0.5e-9,
        order: 1,
        transitionDistance: 20e-9,
      },
      source: "authored_object_region",
      textureAssignment: "override",
      textureOverrideKind: "uniform",
    });
  });

  it("reports inherited region texture assignment when no local texture ref exists", () => {
    const model = resolveObjectRegionPanelModel(
      {
        kind: "object.region",
        label: "Shell",
        moduleSource: "explorer",
        nodeId: "model:object:film:regions:reg-shell",
        objectId: "film",
        ref: {
          kind: "object.region",
          nodeId: "model:object:film:regions:reg-shell",
          objectId: "film",
          regionId: "reg-shell",
          type: "scene-object",
          visualizationTargetId: "object:film",
        },
      },
      {
        objects: [
          {
            id: "film",
            magnetization_ref: "mag-film",
            material_ref: "mat-film",
            name: "Film",
            visible: true,
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
            name: "Shell",
            owner_object_id: "film",
            priority: 1,
            region_id: "reg-shell",
            source: "authored_object_region",
            source_body_ids: [],
            source_object_ids: ["film"],
          },
        ],
        scene_revision: 12,
      },
    );

    expect(model).toMatchObject({
      effectiveMagnetizationRef: "mag-film",
      regionMagnetizationRef: "inherits object",
      textureAssignment: "inherited",
      textureOverrideKind: "none",
    });
  });

  it("filters region diagnostics to the selected object region", () => {
    const model = resolveObjectRegionPanelModel(
      {
        kind: "object.region.diagnostics",
        label: "Core diagnostics",
        moduleSource: "explorer",
        nodeId: "model:object:film:regions:reg-core:diagnostics",
        objectId: "film",
        ref: {
          kind: "object.region.diagnostics",
          nodeId: "model:object:film:regions:reg-core:diagnostics",
          objectId: "film",
          regionId: "reg-core",
          type: "scene-object",
          visualizationTargetId: "object:film:reg-core",
        },
      },
      {
        objects: [{ id: "film", name: "Film" }],
        revision: 14,
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
            name: "Core",
            owner_object_id: "film",
            region_id: "reg-core",
            source: "authored_object_region",
            source_body_ids: [],
            source_object_ids: ["film"],
          },
          {
            bounds_max: [1, 1, 1],
            bounds_min: [0, 0, 0],
            enabled: true,
            interaction_refs: [],
            material_ref: "mat-film",
            mesh_part_ids: [],
            name: "Shell",
            owner_object_id: "film",
            region_id: "reg-shell",
            source: "authored_object_region",
            source_body_ids: [],
            source_object_ids: ["film"],
          },
        ],
        scene_revision: 14,
      },
      null,
      {
        diagnostics: [
          {
            code: "region_mesh_policy_requires_rebuild",
            diagnostic_id: "diag-core",
            message: "Region mesh policy will apply on the next explicit mesh rebuild.",
            owner_object_id: "film",
            region_id: "reg-core",
            realization_status: "authored_pending_realization",
            severity: "warning",
          },
          {
            code: "region_projection_deferred",
            diagnostic_id: "diag-shell",
            message: "Shell region projection is deferred.",
            owner_object_id: "film",
            region_id: "reg-shell",
            severity: "warning",
          },
          {
            code: "foreign_region",
            diagnostic_id: "diag-foreign",
            message: "Foreign object diagnostic.",
            owner_object_id: "other-film",
            region_id: "reg-core",
            severity: "error",
          },
        ],
        scene_revision: 14,
      },
    );

    expect(model.diagnosticCount).toBe(1);
    expect(model.warningCount).toBe(1);
    expect(model.errorCount).toBe(0);
    expect(model.diagnostics).toEqual([
      {
        capabilityGate: null,
        code: "region_mesh_policy_requires_rebuild",
        diagnosticId: "diag-core",
        message: "Region mesh policy will apply on the next explicit mesh rebuild.",
        realizationStatus: "authored_pending_realization",
        severity: "warning",
      },
    ]);
  });
});
