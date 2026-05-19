import { describe, expect, it } from "vitest";

import { buildModelTree, flattenExplorerNodes } from "./buildModelTree";
import {
  modelTreeSnapshotFromScene,
  modelTreeSnapshotWithStageExecution,
} from "./sceneModelTreeAdapter";

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
        "model:object:free-layer:regions:primary",
        "model:object:free-layer:regions:primary:magnetic-texture",
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
      kind: "airbox.mesh",
      label: "Airbox Quality",
      parentId: "model:mesh",
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
        (node) =>
          node.id === "model:object:box-1:regions:primary:magnetic-texture",
      ),
    ).toMatchObject({
      badge: "Vortex texture",
      kind: "object.region-magnetic-texture",
      label: "Magnetic Texture",
      objectId: "box-1",
      regionId: "region:box-1",
    });
    expect(flattened.map((node) => node.id)).toContain(
      "model:object:box-1:magnetic-texture:transform",
    );
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
            torque_tolerance: "1e-4",
          },
          {
            kind: "run",
            until_seconds: "5e-9",
          },
          {
            artifact_name: "m-relaxed",
            kind: "save_state",
          },
        ],
      },
    });

    const flattened = flattenExplorerNodes(buildModelTree(snapshot));

    expect(flattened.find((node) => node.id === "model:study")?.badge).toBe(
      "3 stages",
    );
    expect(flattened.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "model:study:stage:stage-relax",
        "model:study:stage:1",
        "model:study:stage:2",
      ]),
    );
    expect(
      flattened.find((node) => node.id === "model:study:stage:stage-relax"),
    ).toMatchObject({
      badge: "tol 1e-4",
      kind: "study.stage.relax",
      label: "Relax 1",
    });
    expect(
      flattened.find((node) => node.id === "model:study:stage:1"),
    ).toMatchObject({
      badge: "5e-9 s",
      kind: "study.stage.run",
      label: "Run 2",
    });
    expect(
      flattened.find((node) => node.id === "model:study:stage:2"),
    ).toMatchObject({
      badge: "m-relaxed",
      kind: "study.stage.action",
      label: "Save State 3",
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
      flattened.find((node) => node.id === "model:study:stage:runtime-relax"),
    ).toMatchObject({
      status: "completed",
    });
    expect(
      flattened.find((node) => node.id === "model:study:stage:runtime-run"),
    ).toMatchObject({
      label: "Run 2",
      status: "running",
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
      flattened.find((node) => node.id === "model:study")?.contextCommands,
    ).toEqual(
      expect.arrayContaining([
        "study.run",
        "study.pause",
        "study.resume",
        "study.stop",
        "study.skip",
        "study.compute-fields",
        "study.compute-energies",
        "study.save-checkpoint",
        "study.restore-checkpoint",
        "study.import-state",
        "study.export-state",
        "study.discard-paused-state",
      ]),
    );
    expect(
      flattened.find((node) => node.id === "model:study:stage:0")
        ?.contextCommands,
    ).toEqual(expect.arrayContaining(["study.skip"]));
  });
});
