import { describe, expect, it } from "vitest";

import { buildMeshSnapshotRows } from "./meshBuildSnapshots";

describe("mesh build snapshots", () => {
  it("creates stable summary rows from current and next mesh resources", () => {
    const rows = buildMeshSnapshotRows({
      current: {
        manifest: {
          element_count: 100,
          mesh_name: "old",
          node_count: 60,
          source_scene_revision: 7,
        },
        quality: { quality: { gamma_min: 0.2, sicn_p5: 0.45 } },
      },
      next: {
        build: {
          published_resources: { mesh_revision: 12 },
          source_scene_revision: 8,
        },
        manifest: {
          element_count: 140,
          mesh_name: "new",
          node_count: 80,
          source_scene_revision: 8,
        },
        quality: { quality: { gamma_min: 0.3, sicn_p5: 0.55 } },
      },
    });

    expect(rows).toEqual([
      {
        currentValue: "old",
        group: "identity",
        id: "mesh_name",
        label: "Mesh",
        nextValue: "new",
      },
      {
        currentValue: "7",
        group: "provenance",
        id: "source_scene_revision",
        label: "Scene revision",
        nextValue: "8",
      },
      {
        currentValue: "60",
        group: "topology",
        id: "node_count",
        label: "Nodes",
        nextValue: "80",
      },
      {
        currentValue: "100",
        group: "topology",
        id: "element_count",
        label: "Elements",
        nextValue: "140",
      },
      {
        currentValue: "0.45",
        group: "quality",
        id: "sicn_p5",
        label: "SICN p05",
        nextValue: "0.55",
      },
      {
        currentValue: "0.2",
        group: "quality",
        id: "gamma_min",
        label: "Gamma min",
        nextValue: "0.3",
      },
      {
        currentValue: "unknown",
        group: "publish",
        id: "mesh_revision",
        label: "Published mesh revision",
        nextValue: "12",
      },
    ]);
  });
});
