import { describe, expect, it } from "vitest";

import { resolveViewport3DRolloutRoute } from "../viewport3dRolloutRoute";

const base = {
  minimalViewportSelectionPath: false,
  showGeometryAuthoringViewport: false,
  femDiscretization: true,
  effectiveViewMode: "3D" as const,
  hasFemMeshData: true,
  showFemBoundsPreview: false,
  showVectorSurface3D: false,
  isVectorSurfaceMeshActive: false,
  cutover: false,
};

describe("resolveViewport3DRolloutRoute", () => {
  it("prioritizes minimal diagnostics over every product route", () => {
    expect(
      resolveViewport3DRolloutRoute({
        ...base,
        minimalViewportSelectionPath: true,
        showGeometryAuthoringViewport: true,
      }).route,
    ).toBe("minimal-diagnostic");
  });

  it("reports geometry authoring as its own route", () => {
    expect(
      resolveViewport3DRolloutRoute({
        ...base,
        showGeometryAuthoringViewport: true,
      }).route,
    ).toBe("geometry-authoring");
  });

  it("distinguishes FEM Mesh from FEM 3D", () => {
    expect(resolveViewport3DRolloutRoute(base).route).toBe("fem-3d");
    expect(
      resolveViewport3DRolloutRoute({
        ...base,
        effectiveViewMode: "Mesh",
      }).route,
    ).toBe("fem-mesh");
  });

  it("marks FEM bounds fallback explicitly", () => {
    expect(
      resolveViewport3DRolloutRoute({
        ...base,
        hasFemMeshData: false,
        showFemBoundsPreview: true,
      }),
    ).toMatchObject({
      route: "fem-bounds-fallback",
      fallbackUsed: true,
    });
  });

  it("keeps FDM 3D and FDM mesh routes separate", () => {
    expect(
      resolveViewport3DRolloutRoute({
        ...base,
        femDiscretization: false,
        showVectorSurface3D: true,
      }).route,
    ).toBe("fdm-3d");
    expect(
      resolveViewport3DRolloutRoute({
        ...base,
        femDiscretization: false,
        showVectorSurface3D: true,
        isVectorSurfaceMeshActive: true,
      }).route,
    ).toBe("fdm-mesh");
  });
});
