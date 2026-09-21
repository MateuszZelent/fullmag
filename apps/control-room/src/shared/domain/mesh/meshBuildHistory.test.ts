import { describe, expect, it } from "vitest";

import {
  meshBuildHistoryComparisonForSelection,
  latestMeshBuildComparison,
  normalizeMeshBuildHistory,
} from "./meshBuildHistory";

describe("mesh build history model", () => {
  it("normalizes build entries with deltas against the previous build", () => {
    expect(
      normalizeMeshBuildHistory([
        {
          mesh_name: "shared-domain",
          node_count: 10,
          element_count: 20,
          generation_mode: "generated",
          quality: { gamma_min: 0.11, sicn_p5: 0.42 },
        },
        {
          mesh_name: "shared-domain",
          node_count: 14,
          element_count: 31,
          generation_mode: "remesh",
          mesh_reason: "local_refinement",
          quality: { avg_quality: 0.71, gamma_min: 0.2, sicn_p5: 0.5 },
          quality_data_artifact: { path: "/tmp/q.fmmq" },
        },
      ]),
    ).toMatchObject([
      {
        avgQuality: null,
        boundaryFaceCount: null,
        deltaElementCount: null,
        deltaNodeCount: null,
        elementCount: 20,
        gammaMin: 0.11,
        generationMode: "generated",
        index: 0,
        kind: null,
        meshName: "shared-domain",
        meshReason: null,
        meshTarget: null,
        nodeCount: 10,
        qualityDataAvailable: false,
        sicnP05: 0.42,
      },
      {
        avgQuality: 0.71,
        boundaryFaceCount: null,
        deltaElementCount: 11,
        deltaNodeCount: 4,
        elementCount: 31,
        gammaMin: 0.2,
        generationMode: "remesh",
        index: 1,
        kind: null,
        meshName: "shared-domain",
        meshReason: "local_refinement",
        meshTarget: null,
        nodeCount: 14,
        qualityDataAvailable: true,
        sicnP05: 0.5,
      },
    ]);
    const entries = normalizeMeshBuildHistory([
      {
        build_id: "build-a",
        canonical_policy_snapshot: { shared_domain: { hmax: 1e-6 } },
        mesh_name: "shared-domain",
        node_count: 10,
        element_count: 20,
      },
      {
        build_id: "build-b",
        canonical_policy_snapshot: { shared_domain: { hmax: 5e-7 } },
        mesh_name: "shared-domain",
        node_count: 14,
        element_count: 31,
      },
    ]);
    expect(entries.map((entry) => entry.id)).toEqual(["build-a", "build-b"]);
    expect(entries[1].restorable).toBe(true);
    expect(entries[1].canonicalPolicySnapshot).toEqual({
      shared_domain: { hmax: 5e-7 },
    });
  });

  it("compares the latest build side-by-side with the previous build", () => {
    const entries = normalizeMeshBuildHistory([
      {
        mesh_name: "shared-domain",
        node_count: 10,
        element_count: 20,
        boundary_face_count: 12,
        quality: { avg_quality: 0.5, gamma_min: 0.11, sicn_p5: 0.42 },
      },
      {
        mesh_name: "shared-domain",
        node_count: 14,
        element_count: 31,
        boundary_face_count: 18,
        quality: { avg_quality: 0.71, gamma_min: 0.2, sicn_p5: 0.5 },
      },
    ]);

    expect(latestMeshBuildComparison(entries)).toEqual({
      afterIndex: 1,
      beforeIndex: 0,
      rows: [
        {
          after: 14,
          before: 10,
          delta: 4,
          id: "nodes",
          label: "Nodes",
        },
        {
          after: 31,
          before: 20,
          delta: 11,
          id: "elements",
          label: "Elements",
        },
        {
          after: 18,
          before: 12,
          delta: 6,
          id: "boundary_faces",
          label: "Boundary faces",
        },
        {
          after: 0.5,
          before: 0.42,
          delta: 0.08,
          id: "sicn_p05",
          label: "SICN p05",
        },
        {
          after: 0.2,
          before: 0.11,
          delta: 0.09,
          id: "gamma_min",
          label: "Gamma min",
        },
        {
          after: 0.71,
          before: 0.5,
          delta: 0.21,
          id: "avg_quality",
          label: "Average quality",
        },
      ],
    });
  });

  it("compares an explicit non-adjacent build pair", () => {
    const entries = normalizeMeshBuildHistory([
      {
        mesh_name: "shared-domain",
        node_count: 10,
        element_count: 20,
        quality: { avg_quality: 0.5, gamma_min: 0.11, sicn_p5: 0.42 },
      },
      {
        mesh_name: "shared-domain",
        node_count: 12,
        element_count: 24,
        quality: { avg_quality: 0.55, gamma_min: 0.12, sicn_p5: 0.43 },
      },
      {
        mesh_name: "shared-domain",
        node_count: 19,
        element_count: 36,
        quality: { avg_quality: 0.74, gamma_min: 0.2, sicn_p5: 0.5 },
      },
    ]);

    expect(
      meshBuildHistoryComparisonForSelection(entries, {
        afterIndex: 2,
        beforeIndex: 0,
      }),
    ).toMatchObject({
      afterIndex: 2,
      beforeIndex: 0,
      rows: [
        { after: 19, before: 10, delta: 9, id: "nodes" },
        { after: 36, before: 20, delta: 16, id: "elements" },
        { id: "boundary_faces" },
        { after: 0.5, before: 0.42, delta: 0.08, id: "sicn_p05" },
        { after: 0.2, before: 0.11, delta: 0.09, id: "gamma_min" },
        { after: 0.74, before: 0.5, delta: 0.24, id: "avg_quality" },
      ],
    });
    expect(
      meshBuildHistoryComparisonForSelection(entries, {
        afterIndex: 99,
        beforeIndex: 0,
      }),
    ).toBeNull();
  });

  it("keeps a selected pair addressable by stable build ids after append", () => {
    const entries = normalizeMeshBuildHistory([
      { build_id: "build-a", mesh_name: "mesh-a", node_count: 10, element_count: 20 },
      { build_id: "build-b", mesh_name: "mesh-b", node_count: 14, element_count: 28 },
    ]);
    const selection = { beforeId: "build-a", afterId: "build-b" };
    const appended = normalizeMeshBuildHistory([
      { build_id: "build-a", mesh_name: "mesh-a", node_count: 10, element_count: 20 },
      { build_id: "build-b", mesh_name: "mesh-b", node_count: 14, element_count: 28 },
      { build_id: "build-c", mesh_name: "mesh-c", node_count: 21, element_count: 39 },
    ]);
    const comparison = meshBuildHistoryComparisonForSelection(appended, selection);
    expect(comparison).not.toBeNull();
    expect(comparison).toMatchObject({ beforeIndex: 0, afterIndex: 1 });
    expect(comparison?.rows[0]).toMatchObject({ id: "nodes", before: 10, after: 14 });
    expect(entries[0].id).toBe("build-a");
  });

  it("normalizes backend duration_ms to seconds", () => {
    const [entry] = normalizeMeshBuildHistory([
      { build_id: "build-duration", duration_ms: 2_750 },
    ]);

    expect(entry.durationSeconds).toBe(2.75);
  });
});
