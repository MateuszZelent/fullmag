import { describe, expect, it } from "vitest";

import {
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
