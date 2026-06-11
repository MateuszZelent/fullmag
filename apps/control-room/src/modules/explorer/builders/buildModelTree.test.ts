import { describe, expect, it } from "vitest";

import type { SceneResource } from "@/kernel/api/apiTypes";

import { buildModelTree, flattenExplorerNodes } from "./buildModelTree";
import {
  modelTreeSnapshotFromScene,
  modelTreeSnapshotWithStageExecution,
} from "./sceneModelTreeAdapter";

const TORQUE_TOLERANCE_FOR_1E_4_T = 1e-4 / (4 * Math.PI * 1e-7);

describe("buildModelTree", () => {
  it("builds a typed model tree from a scene snapshot without storing API data", () => {
    const nodes = buildModelTree({
      universe: {
        id: "u0",
        label: "Universe",
        size: [2e-6, 1e-6, 5e-8],
      },
      materials: [
        {
          id: "mat:free-layer",
          label: "Free layer material",
          propertyKeys: ["Aex", "Ms", "alpha"],
        },
      ],
      objects: [
        {
          id: "free-layer",
          label: "Free layer",
          geometryKind: "thin film",
          material: "Permalloy",
          materialLabel: "Free layer material",
          materialPropertyKeys: ["Aex", "Ms", "alpha"],
          meshStatus: "stale",
          physicsInteractions: [
            {
              enabledCount: 1,
              id: "uniaxial_anisotropy",
              label: "Uniaxial anisotropy",
              objectCount: 1,
            },
          ],
        },
      ],
      physicsInteractions: [
        {
          enabledCount: 1,
          id: "uniaxial_anisotropy",
          label: "Uniaxial anisotropy",
          objectCount: 1,
        },
      ],
    });

    const flattened = flattenExplorerNodes(nodes);

    expect(nodes[0]?.kind).toBe("session.root");
    expect(flattened.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "model:universe",
        "model:objects",
        "model:object:free-layer",
        "model:object:free-layer:geometry",
        "model:object:free-layer:regions",
        "model:object:free-layer:magnetic-parameters",
        "model:object:free-layer:magnetic-parameters:material",
        "model:object:free-layer:magnetic-parameters:uniaxial_anisotropy",
        "model:object:free-layer:magnetic-texture",
        "model:object:free-layer:magnetic-texture:asset",
        "model:object:free-layer:mesh",
        "model:object:free-layer:visualization",
        "model:airbox:mesh",
        "model:airbox:visualization",
        "model:mesh",
        "model:mesh:airbox-quality",
        "model:study",
      ]),
    );
    expect(
      flattened.find((node) => node.id === "model:object:free-layer:mesh")
        ?.status,
    ).toBe("stale");
    expect(
      flattened.find((node) => node.id === "model:mesh:airbox-quality"),
    ).toMatchObject({
      kind: "airbox.mesh-quality",
      label: "Airbox Quality",
      parentId: "model:mesh",
    });
    expect(
      flattened.find((node) => node.id === "model:object:free-layer:regions"),
    ).toMatchObject({
      badge: "0",
      children: [],
      kind: "object.regions",
      label: "Regions",
    });
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:object:free-layer:regions:primary",
    );
  });

  it("labels the shared-domain mesh node from mesh build freshness", () => {
    const flattened = flattenExplorerNodes(
      buildModelTree({
        mesh: {
          meshName: "shared-domain",
          meshRevision: 12,
          sourceSceneRevision: 5,
          manifestSourceSceneRevision: 4,
        },
      }),
    );

    expect(
      flattened.find((node) => node.id === "model:mesh:shared-domain"),
    ).toMatchObject({
      badge: "stale",
      status: "mesh-stale",
    });
  });

  it("projects canonical SceneDocument objects into lifecycle-aware nodes", () => {
    const snapshot = modelTreeSnapshotFromScene({
      materials: [
        {
          id: "mat-1",
          name: "Material 1",
          properties: { Aex: 1e-11, Dind: 0.001, Ms: 800000, alpha: 0.02 },
        },
      ],
      magnetization_assets: [
        {
          id: "mag-1",
          kind: "preset_texture",
          preset_kind: "vortex",
          texture_transform: {
            pivot: [0, 0, 0],
            rotation_quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
            translation: [0, 0, 0],
          },
          ui_label: "Vortex texture",
        },
      ],
      objects: [
        {
          geometry: {
            geometry_kind: "Box",
            geometry_params: { size: [1, 2, 3] },
          },
          id: "box-1",
          magnetization_ref: "mag-1",
          material_ref: "mat-1",
          name: "Box 1",
          physics_stack: [
            { enabled: true, kind: "exchange" },
            { enabled: false, kind: "demag" },
          ],
          tags: ["mesh:dirty"],
        },
      ],
      revision: 4,
      universe: {
        size: [1e-6, 2e-6, 3e-6],
      },
    });

    const flattened = flattenExplorerNodes(buildModelTree(snapshot));

    expect(
      flattened.find((node) => node.id === "model:object:box-1")?.status,
    ).toBe("mesh-stale");
    expect(
      flattened.find((node) => node.id === "model:object:box-1:mesh")?.badge,
    ).toBe("mesh stale");
    expect(
      flattened.find((node) => node.id === "model:object:box-1:magnetic-parameters")
        ?.label,
    ).toBe("Magnetic Parameters");
    expect(
      flattened.find(
        (node) => node.id === "model:object:box-1:magnetic-parameters:material",
      )?.label,
    ).toBe("Material: Material 1");
    expect(
      flattened.find(
        (node) => node.id === "model:object:box-1:magnetic-parameters:material",
      )?.badge,
    ).toBe("Aex, Dind, Ms");
    expect(
      flattened.find(
        (node) =>
          node.id === "model:object:box-1:magnetic-parameters:interfacial_dmi",
      )?.badge,
    ).toBe("active");
    expect(
      flattened.find(
        (node) => node.id === "model:object:box-1:magnetic-parameters:exchange",
      )?.badge,
    ).toBe("active");
    expect(
      flattened.find(
        (node) => node.id === "model:object:box-1:magnetic-parameters:demag",
      )?.badge,
    ).toBe("disabled");
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:materials",
    );
    expect(flattened.map((node) => node.id)).not.toContain("model:physics");
    expect(
      flattened.find(
        (node) => node.id === "model:object:box-1:magnetic-texture",
      )?.badge,
    ).toBe("preset_texture");
    expect(
      flattened.find(
        (node) => node.id === "model:object:box-1:magnetic-texture:asset",
      )?.label,
    ).toBe("Vortex texture");
    expect(
      flattened.find(
        (node) => node.id === "model:object:box-1:magnetic-texture:asset",
      )?.kind,
    ).toBe("object.magnetic-texture.asset");
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:object:box-1:magnetic-texture:load",
    );
    expect(
      flattened.find(
        (node) => node.id === "model:object:box-1:magnetic-texture",
      )?.contextCommands,
    ).toEqual(expect.arrayContaining(["magnetization-texture.activate-load-file"]));
    expect(flattened.map((node) => node.id)).toContain(
      "model:object:box-1:magnetic-texture:transform",
    );
    expect(
      flattened.find(
        (node) => node.id === "model:object:box-1:magnetic-texture:transform",
      )?.kind,
    ).toBe("object.magnetic-texture.transform");
    expect(
      flattened.find((node) => node.id === "model:object:box-1")
        ?.contextCommands,
    ).toEqual(
      expect.arrayContaining([
        "geometry.focus-primitive",
        "geometry.delete-object",
        "mesh.build-selected",
      ]),
    );
  });

  it("projects antenna scene objects without magnetic object children", () => {
    const snapshot = modelTreeSnapshotFromScene({
      current_modules: {
        modules: [
          {
            kind: "antenna_field_source",
            model: "prescribed_zeeman_mask",
            name: "center_drive",
            object: "center_microstrip",
          },
        ],
      },
      objects: [
        {
          geometry: {
            geometry_kind: "Box",
            geometry_params: { size: [50e-9, 1e-6, 10e-9] },
          },
          id: "center_microstrip",
          name: "Center microstrip",
          role: "antenna",
          tags: ["role:antenna"],
          visualization_hint: { role: "antenna" },
        },
      ],
    });

    const flattened = flattenExplorerNodes(buildModelTree(snapshot));

    expect(
      flattened.find((node) => node.id === "model:object:center_microstrip"),
    ).toMatchObject({
      badge: "Box",
      icon: "wave",
      status: "ready",
    });
    expect(flattened.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "model:object:center_microstrip:geometry",
        "model:object:center_microstrip:antenna",
        "model:object:center_microstrip:visualization",
      ]),
    );
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:object:center_microstrip:magnetic-parameters",
    );
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:object:center_microstrip:magnetic-texture",
    );
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:object:center_microstrip:mesh",
    );
  });

  it("shows authored object regions, material fields, and couplings from model resources", () => {
    const snapshot = modelTreeSnapshotFromScene(
      {
        objects: [
          {
            geometry: { geometry_kind: "Box" },
            id: "film",
            material_ref: "mat-film",
            name: "Film",
          },
        ],
      },
      {
        couplings: {
          couplings: [
            {
              coupling_id: "cpl-exchange",
              coupling_kind: "exchange",
              enabled: true,
              params: {},
              realization_status: "authored_pending_realization",
              source: { object: "film", region_id: "reg-core" },
              target: { object: "film", region_id: "reg-edge" },
            },
          ],
          scene_revision: 3,
        } as never,
        materialFields: {
          fields: [
            {
              assignment_id: "field-ms-core",
              field: {},
              owner_object_id: "film",
              parameter: "Ms",
              realization_status: "authored_pending_realization",
              source_region_id: "reg-core",
              unit: "A/m",
            },
          ],
          scene_revision: 3,
        } as never,
        regions: {
          geometry_realization_revision: 0,
          regions: [
            {
              bounds_max: [0, 0, 0],
              bounds_min: [0, 0, 0],
              enabled: true,
              interaction_refs: [],
              material_parameter_fields: [],
              material_overrides: [{ parameter: "Aex" }],
              material_ref: "mat-film",
              mesh_part_ids: [],
              mesh_policy: { maximum_element_size: 1e-9 },
              name: "Skyrmion core",
              owner_object_id: "film",
              priority: 10,
              region_id: "reg-core",
              region_kind: "object_region",
              realization_status: "authored_pending_realization",
              shape: { kind: "cylinder" },
              source: "authored_object_region",
              source_body_ids: [],
              source_object_ids: ["film"],
            },
          ],
          scene_revision: 3,
        } as never,
      },
    );

    const flattened = flattenExplorerNodes(buildModelTree(snapshot));

    expect(
      flattened.find((node) => node.id === "model:object:film:regions")?.badge,
    ).toBe("1");
    expect(
      flattened.find((node) => node.id === "model:object:film:regions")
        ?.contextCommands,
    ).toEqual(
      expect.arrayContaining(["workspace.focus-selection", "mesh.open-regions"]),
    );
    expect(
      flattened.find((node) => node.id === "model:object:film:regions:reg-core"),
    ).toMatchObject({
      kind: "object.region",
      label: "Skyrmion core",
      objectId: "film",
      regionId: "reg-core",
    });
    expect(
      flattened.find((node) => node.id === "model:object:film:regions:reg-core")
        ?.contextCommands,
    ).toEqual(
      expect.arrayContaining([
        "regions.focus",
        "regions.duplicate",
        "regions.delete",
        "regions.priority-up",
        "regions.priority-down",
        "mesh.open-region-report",
      ]),
    );
    expect(
      flattened.find(
        (node) => node.id === "model:object:film:regions:reg-core:geometry",
      ),
    ).toMatchObject({ badge: "cylinder", kind: "object.region.geometry" });
    expect(
      flattened.find(
        (node) =>
          node.id === "model:object:film:regions:reg-core:magnetic-parameters",
      )?.badge,
    ).toBe("1 override / 1 field");
    expect(
      flattened.find(
        (node) =>
          node.id ===
          "model:object:film:regions:reg-core:magnetic-parameters:field-ms-core",
      ),
    ).toMatchObject({ badge: "authored_pending_realization", label: "Ms (A/m)" });
    expect(
      flattened.find(
        (node) =>
          node.id === "model:object:film:regions:reg-core:visualization",
      ),
    ).toMatchObject({ kind: "object.region.visualization", badge: "display" });
    expect(
      flattened.find(
        (node) => node.id === "model:object:film:regions:reg-core:regions",
      ),
    ).toMatchObject({ kind: "object.region.regions", badge: "inherits none" });
    expect(
      flattened.find((node) => node.id === "model:physics:couplings"),
    ).toMatchObject({ badge: "1", kind: "physics.couplings" });
    expect(
      flattened.find(
        (node) => node.id === "model:physics:couplings:cpl-exchange",
      ),
    ).toMatchObject({
      couplingId: "cpl-exchange",
      kind: "physics.coupling",
      status: "warning",
    });
    expect(
      flattened.find(
        (node) => node.id === "model:physics:couplings:cpl-exchange",
      )?.contextCommands,
    ).toEqual(
      expect.arrayContaining([
        "workspace.focus-selection",
        "couplings.disable",
        "couplings.delete",
      ]),
    );
  });

  it("uses typed scene material field owner_object when projecting region field nodes", () => {
    const scene: SceneResource = {
      objects: [
        {
          id: "film-a",
          material_parameter_fields: [
            {
              assignment_id: "field-ms-core",
              owner_object: "film-b",
              parameter: "ms",
              region_id: "reg-core",
              value: { kind: "constant", unit: "A/m", value: 800000 },
            },
          ],
        },
        {
          id: "film-b",
          regions: [
            {
              name: "Core",
              region_id: "reg-core",
              shape: { center: [0, 0, 0], kind: "sphere", radius: 1e-9 },
            },
          ],
        },
      ],
    };

    const flattened = flattenExplorerNodes(
      buildModelTree(modelTreeSnapshotFromScene(scene)),
    );

    expect(
      flattened.find(
        (node) =>
          node.id ===
          "model:object:film-b:regions:reg-core:magnetic-parameters:field-ms-core",
      ),
    ).toMatchObject({
      badge: "field",
      kind: "object.region.magnetic-parameters",
      label: "ms (A/m)",
      objectId: "film-b",
      regionId: "reg-core",
    });
    expect(
      flattened.map((node) => node.id),
    ).not.toContain(
      "model:object:film-a:regions:reg-core:magnetic-parameters:field-ms-core",
    );
  });

  it("shows object texture load nodes only after activation", () => {
    const flattened = flattenExplorerNodes(
      buildModelTree({
        objects: [
          {
            id: "box-1",
            label: "Box 1",
            textureLoadEnabled: true,
          },
        ],
      }),
    );

    expect(
      flattened.find(
        (node) => node.id === "model:object:box-1:magnetic-texture:load",
      ),
    ).toMatchObject({
      badge: "h5/zarr",
      contextCommands: ["study.load-field-state"],
      kind: "object.magnetic-texture.load",
      label: "Load texture",
      objectId: "box-1",
    });
  });

  it("keeps the explorer renderable before the scene resource is loaded", () => {
    const snapshot = modelTreeSnapshotFromScene(null);
    const flattened = flattenExplorerNodes(buildModelTree(snapshot));

    expect(snapshot.objects).toEqual([]);
    expect(flattened.map((node) => node.id)).toEqual(
      expect.arrayContaining(["model:universe", "model:objects"]),
    );
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:object:free-layer",
    );
    expect(flattened.map((node) => node.id)).not.toContain("model:materials");
    expect(flattened.map((node) => node.id)).not.toContain("model:physics");
  });

  it("does not synthesize demo objects when the scene snapshot is missing", () => {
    const flattened = flattenExplorerNodes(buildModelTree(null));

    expect(flattened.map((node) => node.id)).toEqual(
      expect.arrayContaining(["model:universe", "model:objects"]),
    );
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:object:free-layer",
    );
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:object:reference-layer",
    );
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:material:permalloy",
    );
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:material:cofeb",
    );
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:physics:exchange",
    );
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:physics:demag",
    );
    expect(flattened.find((node) => node.id === "model:objects")?.badge).toBe(
      "0",
    );
  });

  it("builds study stages from the canonical scene instead of hardcoded demo stages", () => {
    const snapshot = modelTreeSnapshotFromScene({
      objects: [],
      study: {
        demag_realization: "poisson_robin",
        stages: [
          {
            stage_id: "stage-relax",
            kind: "relax",
            max_steps: "2000",
            torque_tolerance_apm: TORQUE_TOLERANCE_FOR_1E_4_T,
          },
          {
            kind: "run",
            until_seconds: "5e-9",
          },
          {
            artifact_name: "m-relaxed",
            kind: "save_state",
          },
          {
            field_steps: 11,
            kind: "hysteresis",
            stage_id: "hysteresis-1",
          },
          {
            kind: "frequency_response",
            stage_id: "freq-1",
          },
        ],
      },
    });

    const flattened = flattenExplorerNodes(buildModelTree(snapshot));

    expect(flattened.find((node) => node.id === "model:study")?.badge).toBe(
      "5 stages",
    );
    expect(flattened.find((node) => node.id === "model:study")).toMatchObject({
      children: expect.arrayContaining([
        expect.objectContaining({ id: "model:study:stages" }),
        expect.objectContaining({ id: "model:study:execution" }),
        expect.objectContaining({ id: "model:study:recovery" }),
      ]),
    });
    expect(
      flattened.find((node) => node.id === "model:study:stages")
        ?.contextCommands,
    ).toEqual(
      expect.arrayContaining([
        "study.add-relax-stage",
        "study.add-run-stage",
        "study.add-hysteresis-stage",
        "study.add-eigenmodes-stage",
        "study.add-frequency-response-stage",
        "study.add-save-state-stage",
      ]),
    );
    expect(flattened.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "model:study:stages:stage:stage-relax",
        "model:study:stages:stage:1",
        "model:study:stages:stage:2",
        "model:study:stages:stage:hysteresis-1",
        "model:study:stages:stage:freq-1",
      ]),
    );
    expect(
      flattened.find(
        (node) => node.id === "model:study:stages:stage:stage-relax",
      ),
    ).toMatchObject({
      badge: "tau 1.000000e-4 T",
      contextCommands: expect.arrayContaining(["study.remove-selected-stage"]),
      kind: "study.stage.relax",
      label: "Relax 1",
      parentId: "model:study:stages",
    });
    expect(
      flattened.find((node) => node.id === "model:study:stages:stage:1"),
    ).toMatchObject({
      badge: "5e-9 s",
      kind: "study.stage.run",
      label: "Run 2",
    });
    expect(
      flattened.find((node) => node.id === "model:study:stages:stage:2"),
    ).toMatchObject({
      badge: "m-relaxed",
      kind: "study.stage.save_state",
      label: "Save State 3",
    });
    expect(
      flattened.find(
        (node) => node.id === "model:study:stages:stage:hysteresis-1",
      ),
    ).toMatchObject({
      kind: "study.stage.hysteresis",
      label: "Hysteresis 4",
    });
    expect(
      flattened.find(
        (node) => node.id === "model:study:stages:stage:freq-1",
      ),
    ).toMatchObject({
      kind: "study.stage.frequency_response",
      label: "Frequency Response 5",
    });
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:study:relax",
    );
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:study:run",
    );
  });

  it("uses stage execution ids and statuses for runtime study stage nodes", () => {
    const snapshot = modelTreeSnapshotWithStageExecution(
      modelTreeSnapshotFromScene({
        objects: [],
        study: {
          stages: [{ kind: "relax" }, { kind: "run" }],
        },
      }),
      {
        active_stage_index: 1,
        active_stage_kind: "run",
        completed_stage_indexes: [0],
        revision: 12,
        runtime_state: "running",
        stage_statuses: ["completed", "running"],
        stages: [
          { index: 0, stage_id: "runtime-relax", status: "completed" },
          { index: 1, stage_id: "runtime-run", status: "running" },
        ],
        total_stages: 2,
      } as never,
    );
    const flattened = flattenExplorerNodes(buildModelTree(snapshot));

    expect(
      flattened.find(
        (node) => node.id === "model:study:stages:stage:runtime-relax",
      ),
    ).toMatchObject({
      stageId: "runtime-relax",
      stageIndex: 0,
      status: "completed",
    });
    expect(
      flattened.find(
        (node) => node.id === "model:study:stages:stage:runtime-run",
      ),
    ).toMatchObject({
      label: "Run 2",
      status: "running",
    });
  });

  it("renders hysteresis as one dynamic field node with settle algorithms", () => {
    const snapshot = modelTreeSnapshotWithStageExecution(
      modelTreeSnapshotFromScene({
        objects: [],
        study: {
          stages: [
            {
              kind: "hysteresis",
              stage_id: "hysteresis-1",
              field_max_mT: 100,
              field_min_mT: -100,
              field_step_mT: 10,
              initial_protocol: "positive_saturation",
              branch_mode: "major_loop",
              saturation: { mode: "auto" },
              settle_pipeline: {
                kind: "sequence",
                steps: [
                  {
                    kind: "relax",
                    method: "llg_overdamped",
                    alpha: 1,
                    torque_tolerance: 1e-5,
                    max_steps: 10000,
                  },
                  {
                    kind: "minimize",
                    method: "projected_gradient_bb",
                    torque_tolerance: 5e-6,
                    energy_tolerance: 1e-20,
                    max_steps: 2000,
                  },
                ],
              },
            },
          ],
        },
      }),
      {
        active_stage_index: 0,
        active_stage_kind: "hysteresis",
        completed_stage_indexes: [],
        revision: 13,
        runtime_state: "running",
        stage_statuses: ["running"],
        stages: [
          {
            index: 0,
            stage_id: "hysteresis-1",
            status: "running",
            current_field_mT: 25,
            current_point_index: 4,
            current_settle_step_index: 1,
            current_settle_step_kind: "minimize",
            current_settle_step_method: "projected_gradient_bb",
          },
        ],
        total_stages: 1,
      } as never,
    );
    const flattened = flattenExplorerNodes(buildModelTree(snapshot));

    expect(
      flattened.filter(
        (node) => node.id.includes(":field-point:") && !node.id.includes(":algorithm:"),
      ),
    ).toHaveLength(1);
    expect(
      flattened.find(
        (node) =>
          node.id ===
          "model:study:stages:stage:hysteresis-1:field-point:4",
      ),
    ).toMatchObject({
      badge: "25 mT / point 5",
      label: "Current Field",
      status: "running",
    });
    expect(
      flattened.find(
        (node) =>
          node.id ===
          "model:study:stages:stage:hysteresis-1:field-point:4:algorithm:0",
      ),
    ).toMatchObject({
      badge: "llg_overdamped",
      label: "Relax 1",
      status: "completed",
    });
    expect(
      flattened.find(
        (node) =>
          node.id ===
          "model:study:stages:stage:hysteresis-1:field-point:4:algorithm:1",
      ),
    ).toMatchObject({
      badge: "projected_gradient_bb",
      label: "Minimize 2",
      status: "running",
    });
  });

  it("renders hysteresis experiment structure without expanding every field point", () => {
    const snapshot = modelTreeSnapshotWithStageExecution(
      modelTreeSnapshotFromScene({
        objects: [],
        study: {
          stages: [
            {
              kind: "hysteresis",
              stage_id: "hysteresis-1",
              field_max_mT: 100,
              field_min_mT: -100,
              field_step_mT: 10,
              initial_protocol: "positive_saturation",
              branch_mode: "major_loop",
              saturation: { mode: "auto" },
              settle_pipeline: {
                kind: "sequence",
                steps: [
                  {
                    kind: "minimize",
                    method: "projected_gradient_bb",
                    torque_tolerance: 5e-5,
                    energy_tolerance: 1e-20,
                    max_steps: 2000,
                  },
                  {
                    kind: "relax",
                    method: "llg_overdamped",
                    torque_tolerance: 1e-5,
                    max_steps: 10000,
                  },
                ],
              },
            },
          ],
        },
      }),
      {
        active_stage_index: 0,
        active_stage_kind: "hysteresis",
        completed_stage_indexes: [],
        revision: 15,
        runtime_state: "running",
        stage_statuses: ["running"],
        stages: [
          {
            index: 0,
            stage_id: "hysteresis-1",
            status: "running",
            current_field_mT: 25,
            current_point_index: 4,
            current_settle_step_index: 0,
            current_settle_step_kind: "minimize",
            current_settle_step_method: "projected_gradient_bb",
          },
        ],
        total_stages: 1,
      } as never,
    );
    const flattened = flattenExplorerNodes(buildModelTree(snapshot));
    const stageId = "model:study:stages:stage:hysteresis-1";

    expect(
      flattened
        .filter((node) => node.parentId === stageId)
        .map((node) => node.id),
    ).toEqual(expect.arrayContaining([
      `${stageId}:plan`,
      `${stageId}:protocol`,
      `${stageId}:saturation`,
      `${stageId}:live-run`,
      `${stageId}:branches`,
      `${stageId}:points`,
      `${stageId}:metrics`,
      `${stageId}:snapshots`,
      `${stageId}:field-point:4`,
    ]));
    expect(flattened.find((node) => node.id === `${stageId}:plan`)).toMatchObject({
      label: "Plan",
      badge: "-100..100 mT / step 10",
      status: "ready",
    });
    expect(flattened.find((node) => node.id === `${stageId}:live-run`)).toMatchObject({
      label: "Live Run",
      badge: "25 mT / point 5",
      status: "running",
    });
    expect(flattened.find((node) => node.id === `${stageId}:protocol`)).toMatchObject({
      badge: "positive_saturation / major_loop",
    });
    expect(flattened.find((node) => node.id === `${stageId}:saturation`)).toMatchObject({
      badge: "auto",
      status: "ready",
    });
    expect(
      flattened
        .filter((node) => node.parentId === `${stageId}:branches`)
        .map((node) => node.id),
    ).toEqual(expect.arrayContaining([
      `${stageId}:branches:forward`,
      `${stageId}:branches:return`,
      `${stageId}:branches:minor-loops`,
    ]));
    expect(
      flattened.filter(
        (node) => node.id.includes(":point:") && !node.id.includes(":field-point:"),
      ),
    ).toHaveLength(0);
  });

  it("renders hysteresis protocol and saturation from the stage contract", () => {
    const snapshot = modelTreeSnapshotFromScene({
      objects: [],
      study: {
        stages: [
          {
            kind: "hysteresis",
            stage_id: "virgin-hysteresis",
            field_max_mT: 80,
            field_min_mT: 0,
            field_step_mT: 2,
            initial_protocol: "zero_field_relaxed",
            branch_mode: "virgin_curve",
          },
        ],
      },
    });
    const flattened = flattenExplorerNodes(buildModelTree(snapshot));
    const stageId = "model:study:stages:stage:virgin-hysteresis";

    expect(flattened.find((node) => node.id === `${stageId}:protocol`)).toMatchObject({
      label: "Protocol",
      badge: "zero_field_relaxed / virgin_curve",
      status: "ready",
    });
    expect(flattened.find((node) => node.id === `${stageId}:saturation`)).toMatchObject({
      label: "Saturation",
      badge: "not configured",
      status: "skipped",
    });
    expect(flattened.find((node) => node.id === `${stageId}:branches`)).toMatchObject({
      label: "Branches",
      badge: "virgin_curve",
    });
  });

  it("summarizes dense hysteresis point plans without rendering every point", () => {
    const snapshot = modelTreeSnapshotWithStageExecution(
      modelTreeSnapshotFromScene({
        objects: [],
        study: {
          stages: [
            {
              kind: "hysteresis",
              stage_id: "hysteresis-1",
              field_max_mT: 1000,
              field_min_mT: -1000,
              field_step_mT: 10,
              settle_pipeline: {
                kind: "sequence",
                steps: [
                  {
                    kind: "relax",
                    method: "llg_overdamped",
                    torque_tolerance: 1e-5,
                    max_steps: 10000,
                  },
                ],
              },
            },
          ],
        },
      }),
      {
        active_stage_index: 0,
        active_stage_kind: "hysteresis",
        completed_stage_indexes: [],
        revision: 14,
        runtime_state: "running",
        stage_statuses: ["running"],
        stages: [
          {
            index: 0,
            stage_id: "hysteresis-1",
            status: "running",
            current_field_mT: -250,
            current_point_index: 125,
            current_settle_step_index: 0,
            current_settle_step_kind: "relax",
            current_settle_step_method: "llg_overdamped",
          },
        ],
        total_stages: 1,
      } as never,
    );
    const flattened = flattenExplorerNodes(buildModelTree(snapshot));

    expect(
      flattened.filter(
        (node) =>
          node.id.includes(":field-point:") &&
          !node.id.includes(":algorithm:"),
      ),
    ).toHaveLength(1);
    expect(
      flattened.find(
        (node) => node.id === "model:study:stages:stage:hysteresis-1:points",
      ),
    ).toMatchObject({
      badge: "126/201",
      label: "Points",
      status: "running",
    });
    expect(
      flattened.find(
        (node) =>
          node.id ===
          "model:study:stages:stage:hysteresis-1:points:completed",
      ),
    ).toMatchObject({
      badge: "125 points",
      label: "Completed Points",
      status: "completed",
    });
    expect(
      flattened.find(
        (node) =>
          node.id ===
          "model:study:stages:stage:hysteresis-1:points:queued",
      ),
    ).toMatchObject({
      badge: "75 points",
      label: "Queued Points",
      status: "queued",
    });
    expect(
      flattened.find(
        (node) =>
          node.id ===
          "model:study:stages:stage:hysteresis-1:field-point:125",
      ),
    ).toMatchObject({
      badge: "-250 mT / point 126",
      label: "Current Field",
      status: "running",
    });
  });

  it("adds visible study stage transition nodes from runtime metadata", () => {
    const snapshot = modelTreeSnapshotWithStageExecution(
      modelTreeSnapshotFromScene({
        objects: [],
        study: {
          stages: [{ kind: "relax" }, { kind: "run" }],
        },
      }),
      {
        active_stage_index: 1,
        active_stage_kind: "run",
        completed_stage_indexes: [0],
        revision: 12,
        runtime_state: "running",
        stage_statuses: ["completed", "running"],
        stages: [
          { index: 0, stage_id: "runtime-relax", status: "completed" },
          {
            index: 1,
            stage_id: "runtime-run",
            status: "running",
            state_transition: "continues",
            state_transition_kind: "continue_in_place",
            state_transition_reason: "same_runtime_context",
            state_transition_ui_presentation: "smooth_arrow",
          },
        ],
        total_stages: 2,
      } as never,
    );
    const flattened = flattenExplorerNodes(buildModelTree(snapshot));

    expect(
      flattened.find(
        (node) =>
          node.id ===
          "model:study:stages:stage:runtime-run:state-transition",
      ),
    ).toMatchObject({
      label: "State Transition",
      badge: "continues",
      parentId: "model:study:stages:stage:runtime-run",
      status: "ready",
    });
  });

  it("exposes study runtime and recovery commands through explorer context menus", () => {
    const flattened = flattenExplorerNodes(
      buildModelTree(
        modelTreeSnapshotFromScene({
          objects: [],
          study: {
            stages: [{ kind: "relax" }],
          },
        }),
      ),
    );

    expect(
      flattened.find((node) => node.id === "model:study:execution")
        ?.contextCommands,
    ).toEqual(
      expect.arrayContaining([
        "study.run",
        "study.pause",
        "study.resume",
        "study.stop",
        "study.skip",
        "study.compute-fields",
        "study.compute-energies",
      ]),
    );
    expect(
      flattened.find((node) => node.id === "model:study:recovery")
        ?.contextCommands,
    ).toEqual(
      expect.arrayContaining([
        "study.save-checkpoint",
        "study.restore-checkpoint",
        "study.import-state",
        "study.export-state",
        "study.discard-paused-state",
      ]),
    );
    expect(
      flattened.find((node) => node.id === "model:study:stages:stage:0")
        ?.contextCommands,
    ).toEqual(expect.arrayContaining(["study.skip"]));
  });

  it("shows editable 2D visualization drafts and committed plots", () => {
    const flattened = flattenExplorerNodes(
      buildModelTree({
        crossSections: {
          activePlotId: "plot-1",
          draft: {
            colorScale: "jet",
            filterExpression: "",
            frameExtent: "universe",
            id: "draft",
            includeWireframe: true,
            metric: "skewness",
            name: "Draft Cross-Section",
            plane: "xy",
            positionPercent: 50,
            rotationDegrees: 0,
            shrinkFactor: 1,
          },
          plots: [
            {
              colorScale: "viridis",
              filterExpression: "quality < 0.3",
              frameExtent: "universe",
              id: "plot-1",
              metric: "aspect_ratio",
              name: "Plot 1",
              plane: "xz",
              positionPercent: 25,
              rotationDegrees: 0,
              shrinkFactor: 0.8,
              wireframeVisible: true,
            },
          ],
        },
      }),
    );

    expect(
      flattened.find((node) => node.id === "model:visualizations-2d"),
    ).toMatchObject({
      badge: "1 plot",
      kind: "visualizations-2d.root",
      label: "Visualizations 2D",
    });
    expect(
      flattened.find((node) => node.id === "model:visualizations-2d:draft"),
    ).toMatchObject({
      badge: "XY 50% / skewness",
      kind: "visualizations-2d.draft",
      label: "Draft Cross-Section",
    });
    expect(
      flattened.find((node) => node.id === "model:visualizations-2d:plot-1"),
    ).toMatchObject({
      badge: "XZ 25% / aspect_ratio",
      kind: "visualizations-2d.plot",
      label: "Plot 1",
      status: "ready",
    });
    expect(
      flattened.find(
        (node) => node.id === "model:visualizations-2d:plot-1:frame",
      ),
    ).toMatchObject({
      badge: "Universe / 0 deg",
      kind: "visualizations-2d.parameter",
      label: "Frame",
    });
    expect(
      flattened.find(
        (node) => node.id === "model:visualizations-2d:plot-1:quality",
      ),
    ).toMatchObject({
      badge: "aspect_ratio / viridis",
      kind: "visualizations-2d.parameter",
      label: "Quality",
    });
    expect(
      flattened.find(
        (node) => node.id === "model:visualizations-2d:plot-1:render",
      ),
    ).toMatchObject({
      badge: "wireframe on / shrink 0.8 / quality < 0.3",
      kind: "visualizations-2d.parameter",
      label: "Render",
      status: "warning",
    });
  });

  it("merges stage execution by stage id before falling back to index", () => {
    const sceneSnapshot = modelTreeSnapshotFromScene({
      objects: [],
      study: {
        stages: [
          { kind: "relax", stage_id: "relax-main" },
          { kind: "run", stage_id: "run-main" },
        ],
      },
    });

    const snapshot = modelTreeSnapshotWithStageExecution(sceneSnapshot, {
      active_stage_index: null,
      active_stage_kind: null,
      completed_stage_indexes: [1],
      revision: 9,
      runtime_state: "completed",
      stage_statuses: ["running", "completed"],
      stages: [
        { index: 1, stage_id: "run-main", status: "completed" },
        { index: 0, stage_id: "relax-main", status: "running" },
      ],
      total_stages: 2,
    } as never);

    const flattened = flattenExplorerNodes(buildModelTree(snapshot));

    expect(
      flattened.find(
        (node) => node.id === "model:study:stages:stage:relax-main",
      ),
    ).toMatchObject({ label: "Relax 1", status: "running" });
    expect(
      flattened.find(
        (node) => node.id === "model:study:stages:stage:run-main",
      ),
    ).toMatchObject({ label: "Run 2", status: "completed" });
  });
});
