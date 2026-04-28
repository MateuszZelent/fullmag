import { describe, expect, it } from "vitest";

import {
  buildRowsFromMeshStatisticsReport,
  parseOperationStatuses,
  parseThinFilmDiagnostics,
  parseWorstElements,
} from "../MeshStatisticsPanel";

describe("MeshStatisticsPanel backend truth parsers", () => {
  it("reads operation statuses from last build summary", () => {
    const statuses = parseOperationStatuses({
      operation_statuses: [
        {
          kind: "swept_prism",
          scope: "free_layer",
          requested: true,
          status: "fallback",
          requested_method: "swept_prism",
          actual_method: "free_tetrahedral",
          reason: "airbox combined-domain swept workflow is not implemented",
        },
      ],
    });

    expect(statuses).toEqual([
      {
        kind: "swept_prism",
        scope: "free_layer",
        requested: true,
        status: "fallback",
        requestedMethod: "swept_prism",
        actualMethod: "free_tetrahedral",
        reason: "airbox combined-domain swept workflow is not implemented",
      },
    ]);
  });

  it("reads thin-film diagnostics from last build summary", () => {
    const diagnostics = parseThinFilmDiagnostics({
      thin_film_diagnostics: [
        {
          geometry_name: "free_layer",
          is_thin_film: true,
          thickness: 9e-9,
          lateral_size: 100e-9,
          aspect_ratio: 11.1,
          requested_layers: 3,
          estimated_layers_from_hmax: 1,
          hmax_to_thickness_ratio: 0.89,
          requested_method: "swept_prism",
          actual_method: "free_tetrahedral",
          warnings: ["requested swept/prism meshing fell back to free tetrahedral"],
        },
      ],
    });

    expect(diagnostics).toMatchObject([
      {
        geometryName: "free_layer",
        isThinFilm: true,
        requestedLayers: 3,
        actualMethod: "free_tetrahedral",
        warnings: ["requested swept/prism meshing fell back to free tetrahedral"],
      },
    ]);
  });

  it("uses mesh_statistics scopes and worst elements as report truth", () => {
    const report = {
      scopes: [
        {
          id: "marker:0",
          kind: "airbox",
          label: "Airbox",
          role: "air",
          marker: 0,
          element_count: 120,
          boundary_face_count: 12,
          gamma: { min: 0.12, mean: 0.5, histogram: [{ lo: 0, hi: 0.5, count: 4 }] },
          sicn: { min: 0.08, p05: 0.11, mean: 0.4, max: 0.9, histogram: [{ lo: -1, hi: 1, count: 5 }] },
          volume: { min: 1e-27, max: 5e-27, mean: 2e-27, std: 1e-27, ratio: 5 },
        },
      ],
      worst_elements: [
        {
          element_index: 7,
          marker: 0,
          gamma: 0.12,
          volume: 1e-27,
          centroid: [1e-9, 2e-9, 3e-9],
        },
      ],
      quality_source: "gmsh",
    };

    expect(buildRowsFromMeshStatisticsReport(report)).toMatchObject([
      {
        id: "marker:0",
        label: "Airbox",
        role: "air",
        elementCount: 120,
        quality: {
          gamma_min: 0.12,
          sicn_p5: 0.11,
          gamma_histogram: [4],
          sicn_histogram: [5],
        },
      },
    ]);
    expect(parseWorstElements(report)).toEqual([
      {
        id: "worst:7:0",
        elementIndex: 7,
        marker: 0,
        scopeLabel: null,
        gamma: 0.12,
        sicn: null,
        volume: 1e-27,
        centroid: [1e-9, 2e-9, 3e-9],
      },
    ]);
  });
});
