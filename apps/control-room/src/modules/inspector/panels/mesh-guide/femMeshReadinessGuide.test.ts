import { describe, expect, it } from "vitest";

import { evaluateFemMeshReadinessGuide } from "./femMeshReadinessGuide";

describe("evaluateFemMeshReadinessGuide", () => {
  it("reports blocked/missing geometry when the scene has no committed objects", () => {
    const guide = evaluateFemMeshReadinessGuide({
      scene: { objects: [], revision: 1 },
    });

    expect(guide.overallStatus).toBe("blocked");
    expect(guide.overallStatusLabel).toBe("Geometry Required");
    expect(guide.completedRequiredSteps).toBe(0);
    expect(guide.totalRequiredSteps).toBe(3);
    expect(guide.nextRecommendedStep?.id).toBe("geometry");
    expect(guide.steps.find((s) => s.id === "geometry")?.status).toBe("missing");
    expect(guide.steps.find((s) => s.id === "shared-domain-build")?.status).toBe(
      "blocked",
    );
  });

  it("blocks meshing when geometry validation reports errors", () => {
    const guide = evaluateFemMeshReadinessGuide({
      geometryValidation: {
        errors: [{ message: "Box X dimension must be positive", severity: "error" }],
        valid: false,
      },
      scene: {
        objects: [
          {
            geometry: { kind: "box" },
            id: "wg_1",
            material_ref: "permalloy",
            name: "Waveguide",
          },
        ],
        revision: 2,
      },
    });

    expect(guide.overallStatus).toBe("blocked");
    expect(guide.nextRecommendedStep?.id).toBe("geometry");
    expect(guide.steps.find((s) => s.id === "geometry")?.status).toBe("blocked");
    expect(guide.steps.find((s) => s.id === "geometry")?.detail).toContain(
      "Box X dimension must be positive",
    );
  });

  it("flags unassigned object materials and missing shared-domain build on a new object", () => {
    const guide = evaluateFemMeshReadinessGuide({
      geometryValidation: { valid: true },
      scene: {
        objects: [
          {
            geometry: { kind: "box" },
            id: "wg_1",
            material_ref: "unassigned",
            name: "Waveguide",
          },
        ],
        revision: 3,
      },
      universePolicy: {
        config: null,
        effective_config: {
          airbox_hmax: 2e-8,
          airbox_hmin: 5e-9,
          mode: "auto",
          padding: [5e-8, 5e-8, 5e-8],
        },
        revision: 0,
      },
    });

    expect(guide.overallStatus).toBe("needs-build");
    expect(guide.nextRecommendedStep?.id).toBe("materials");
    expect(guide.steps.find((s) => s.id === "geometry")?.status).toBe("ready");
    expect(guide.steps.find((s) => s.id === "materials")?.status).toBe("warning");
    expect(guide.steps.find((s) => s.id === "airbox-domain")?.status).toBe(
      "recommended",
    );
    expect(guide.steps.find((s) => s.id === "object-sizing")?.status).toBe(
      "recommended",
    );
    expect(guide.steps.find((s) => s.id === "shared-domain-build")?.status).toBe(
      "missing",
    );
  });

  it("recommends building the shared-domain mesh when geometry and materials are ready", () => {
    const guide = evaluateFemMeshReadinessGuide({
      geometryValidation: { valid: true },
      meshSemantics: {
        object_configs: [
          {
            config: { maximum_element_size: 5e-9, minimum_element_size: 2e-9 },
            object_id: "wg_1",
          },
        ],
      },
      scene: {
        objects: [
          {
            geometry: { kind: "box" },
            id: "wg_1",
            material_ref: "yig",
            name: "YIG Film",
          },
        ],
        revision: 4,
      },
      universePolicy: {
        config: {
          airbox_hmax: 2.5e-8,
          mode: "auto",
          padding: [1e-7, 1e-7, 1e-7],
        },
        effective_config: {
          airbox_hmax: 2.5e-8,
          mode: "auto",
          padding: [1e-7, 1e-7, 1e-7],
        },
        revision: 0,
      },
    });

    expect(guide.overallStatus).toBe("needs-build");
    expect(guide.nextRecommendedStep?.id).toBe("shared-domain-build");
    expect(guide.steps.find((s) => s.id === "airbox-domain")?.status).toBe("ready");
    expect(guide.steps.find((s) => s.id === "object-sizing")?.status).toBe("ready");
    expect(guide.nextRecommendedStep?.actionTarget).toEqual({
      commandId: "mesh.build-shared-domain",
      kind: "execute-command",
      label: "Build Shared-Domain Mesh",
    });
  });

  it("marks shared-domain mesh as stale when sceneRevision exceeds manifest.source_scene_revision", () => {
    const guide = evaluateFemMeshReadinessGuide({
      geometryValidation: { valid: true },
      manifest: {
        generation_id: "gen_1",
        mesh_id: "mesh_1",
        source_scene_revision: 4,
        topology_counts: { elements: 12400, nodes: 2800 },
      },
      meshSummary: { revision: 1 },
      scene: {
        objects: [
          {
            geometry: { kind: "box" },
            id: "wg_1",
            material_ref: "yig",
            name: "YIG Film",
          },
        ],
        revision: 5,
      },
    });

    expect(guide.overallStatus).toBe("stale");
    expect(guide.overallStatusLabel).toBe("Mesh Stale");
    expect(guide.nextRecommendedStep?.id).toBe("shared-domain-build");
    expect(guide.steps.find((s) => s.id === "shared-domain-build")?.status).toBe(
      "stale",
    );
  });

  it("reports ready when shared-domain mesh is current and quality gates pass", () => {
    const guide = evaluateFemMeshReadinessGuide({
      geometryValidation: { valid: true },
      manifest: {
        generation_id: "gen_2",
        mesh_id: "mesh_2",
        source_scene_revision: 5,
        topology_counts: { elements: 18200, nodes: 4100 },
      },
      meshSemantics: {
        object_configs: [
          {
            config: { maximum_element_size: 4e-9 },
            object_id: "wg_1",
          },
        ],
      },
      meshSummary: { revision: 2 },
      qualityGates: {
        gates: {
          checks: [
            { id: "min_sicn", status: "pass", value: "0.42" },
            { id: "min_gamma", status: "pass", value: "0.51" },
          ],
        },
      },
      scene: {
        objects: [
          {
            geometry: { kind: "box" },
            id: "wg_1",
            material_ref: "yig",
            name: "YIG Film",
          },
        ],
        revision: 5,
      },
      universePolicy: {
        config: { mode: "auto" },
        revision: 2,
      },
    });

    expect(guide.overallStatus).toBe("ready");
    expect(guide.overallStatusLabel).toBe("Mesh Ready");
    expect(guide.completedRequiredSteps).toBe(3);
    expect(guide.progressRatio).toBe(1);
    expect(guide.nextRecommendedStep).toBeNull();
    expect(guide.steps.every((s) => s.status === "ready")).toBe(true);
  });

  it("surfaces quality-warning when a quality gate fails on a current mesh", () => {
    const guide = evaluateFemMeshReadinessGuide({
      geometryValidation: { valid: true },
      manifest: {
        generation_id: "gen_2",
        mesh_id: "mesh_2",
        source_scene_revision: 5,
      },
      meshSummary: { revision: 2 },
      qualityGates: {
        gates: {
          checks: [{ id: "min_sicn", status: "failed", value: "-0.02" }],
        },
      },
      scene: {
        objects: [
          {
            geometry: { kind: "box" },
            id: "wg_1",
            material_ref: "yig",
            name: "YIG Film",
          },
        ],
        revision: 5,
      },
    });

    expect(guide.overallStatus).toBe("quality-warning");
    expect(guide.nextRecommendedStep?.id).toBe("quality-gates");
    expect(guide.steps.find((s) => s.id === "quality-gates")?.status).toBe(
      "failed",
    );
  });
});
