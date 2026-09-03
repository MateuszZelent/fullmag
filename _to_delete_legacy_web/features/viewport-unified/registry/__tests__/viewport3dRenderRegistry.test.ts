import { describe, expect, it } from "vitest";

import {
  resolveViewport3DModeFlags,
  resolveViewport3DRenderRoute,
  resolveViewportInternalToolbarModes,
} from "../viewport3dRenderRegistry";

describe("resolveViewport3DRenderRoute", () => {
  it("prioritizes geometry authoring over solver render routes", () => {
    expect(
      resolveViewport3DRenderRoute({
        showGeometryAuthoringViewport: true,
        isFemMeshMode: true,
        isFem3DMode: true,
      }),
    ).toBe("geometry-authoring");
  });

  it("routes FEM mesh and FEM 3D modes distinctly", () => {
    expect(
      resolveViewport3DRenderRoute({
        showGeometryAuthoringViewport: false,
        isFemMeshMode: true,
        isFem3DMode: false,
      }),
    ).toBe("fem-mesh");

    expect(
      resolveViewport3DRenderRoute({
        showGeometryAuthoringViewport: false,
        isFemMeshMode: false,
        isFem3DMode: true,
      }),
    ).toBe("fem-3d");
  });

  it("falls back to the FDM 3D vector surface route", () => {
    expect(
      resolveViewport3DRenderRoute({
        showGeometryAuthoringViewport: false,
        isFemMeshMode: false,
        isFem3DMode: false,
      }),
    ).toBe("fdm-3d");
  });
});

describe("resolveViewport3DModeFlags", () => {
  it("routes FEM Mesh through the dedicated fem-mesh path instead of fem-3d", () => {
    expect(
      resolveViewport3DModeFlags({
        isFemDiscretization: true,
        viewMode: "Mesh",
      }),
    ).toEqual({
      isFemMeshMode: true,
      isFem3DMode: false,
    });
  });

  it("keeps FEM 3D and FDM mesh modes distinct", () => {
    expect(
      resolveViewport3DModeFlags({
        isFemDiscretization: true,
        viewMode: "3D",
      }),
    ).toEqual({
      isFemMeshMode: false,
      isFem3DMode: true,
    });

    expect(
      resolveViewport3DModeFlags({
        isFemDiscretization: false,
        viewMode: "Mesh",
      }),
    ).toEqual({
      isFemMeshMode: false,
      isFem3DMode: false,
    });
  });
});

describe("resolveViewportInternalToolbarModes", () => {
  it("hides FEM and FDM internal toolbars when the unified toolbar is enabled", () => {
    expect(
      resolveViewportInternalToolbarModes({
        unifiedToolbarEnabled: true,
        femDiagnosticToolbarEnabled: true,
      }),
    ).toEqual({
      femToolbarMode: "hidden",
      vectorToolbarMode: "hidden",
    });
  });

  it("keeps legacy renderer toolbars as diagnostic fallback when unified toolbar is disabled", () => {
    expect(
      resolveViewportInternalToolbarModes({
        unifiedToolbarEnabled: false,
        femDiagnosticToolbarEnabled: true,
      }),
    ).toEqual({
      femToolbarMode: "visible",
      vectorToolbarMode: "visible",
    });
  });
});
