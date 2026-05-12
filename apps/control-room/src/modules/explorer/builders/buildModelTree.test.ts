import { describe, expect, it } from "vitest";

import { buildModelTree, flattenExplorerNodes } from "./buildModelTree";
import { modelTreeSnapshotFromScene } from "./sceneModelTreeAdapter";

describe("buildModelTree", () => {
  it("builds a typed model tree from a scene snapshot without storing API data", () => {
    const nodes = buildModelTree({
      universe: {
        id: "u0",
        label: "Universe",
        size: [2e-6, 1e-6, 5e-8],
      },
      objects: [
        {
          id: "free-layer",
          label: "Free layer",
          geometryKind: "thin film",
          material: "Permalloy",
          meshStatus: "stale",
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
        "model:object:free-layer:material",
        "model:object:free-layer:physics",
        "model:object:free-layer:mesh",
        "model:object:free-layer:visualization",
        "model:airbox:mesh",
        "model:airbox:visualization",
      ]),
    );
    expect(
      flattened.find((node) => node.id === "model:object:free-layer:mesh")
        ?.status,
    ).toBe("stale");
  });

  it("projects canonical SceneDocument objects into lifecycle-aware nodes", () => {
    const snapshot = modelTreeSnapshotFromScene({
      objects: [
        {
          geometry: {
            geometry_kind: "Box",
            geometry_params: { size: [1, 2, 3] },
          },
          id: "box-1",
          material_ref: "mat-1",
          name: "Box 1",
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
      flattened.find((node) => node.id === "model:object:box-1:physics")
        ?.label,
    ).toBe("Physics");
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
    expect(flattened.find((node) => node.id === "model:objects")?.badge).toBe(
      "0",
    );
  });
});
