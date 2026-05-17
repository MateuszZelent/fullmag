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
    ).toEqual([
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
});
