import { describe, expect, it } from "vitest";

import { resolveFemGeometryRenderPasses } from "../femGeometryRenderPasses";

describe("resolveFemGeometryRenderPasses", () => {
  it("renders wireframe-only from edge geometry when available", () => {
    expect(
      resolveFemGeometryRenderPasses({
        renderMode: "wireframe",
        hasGeometry: true,
        hasEdgesGeometry: true,
        showSurfacePass: true,
        showSurfaceHiddenEdgesPass: true,
        showSurfaceVisibleEdgesPass: true,
        showPointsPass: true,
      }),
    ).toMatchObject({
      showSurface: false,
      showWireOnlyEdges: true,
      showWireOnlyMesh: false,
      showSurfaceEdges: false,
      showSurfaceEdgeFallback: false,
      showPoints: false,
    });
  });

  it("falls back to material wireframe without requiring edges geometry", () => {
    expect(
      resolveFemGeometryRenderPasses({
        renderMode: "wireframe",
        hasGeometry: true,
        hasEdgesGeometry: false,
        showSurfacePass: true,
        showSurfaceHiddenEdgesPass: true,
        showSurfaceVisibleEdgesPass: true,
        showPointsPass: true,
      }),
    ).toMatchObject({
      showSurface: false,
      showWireOnlyEdges: false,
      showWireOnlyMesh: true,
      showSurfaceEdges: false,
      showSurfaceEdgeFallback: false,
      showPoints: false,
    });
  });

  it("renders shaded surface edges only when edge geometry exists", () => {
    expect(
      resolveFemGeometryRenderPasses({
        renderMode: "surface+edges",
        hasGeometry: true,
        hasEdgesGeometry: true,
        showSurfacePass: true,
        showSurfaceHiddenEdgesPass: true,
        showSurfaceVisibleEdgesPass: true,
        showPointsPass: true,
      }),
    ).toMatchObject({
      showSurface: true,
      showWireOnlyEdges: false,
      showWireOnlyMesh: false,
      showSurfaceEdges: true,
      showSurfaceEdgeFallback: false,
      showPoints: false,
    });

    expect(
      resolveFemGeometryRenderPasses({
        renderMode: "surface+edges",
        hasGeometry: true,
        hasEdgesGeometry: false,
        showSurfacePass: true,
        showSurfaceHiddenEdgesPass: true,
        showSurfaceVisibleEdgesPass: true,
        showPointsPass: true,
      }),
    ).toMatchObject({
      showSurface: true,
      showSurfaceEdges: false,
    });
  });

  it("renders shaded edge fallback when explicit hidden and visible edge passes are disabled", () => {
    expect(
      resolveFemGeometryRenderPasses({
        renderMode: "surface+edges",
        hasGeometry: true,
        hasEdgesGeometry: true,
        showSurfacePass: true,
        showSurfaceHiddenEdgesPass: false,
        showSurfaceVisibleEdgesPass: false,
        showPointsPass: true,
      }),
    ).toMatchObject({
      showSurface: true,
      showSurfaceEdges: true,
      showSurfaceEdgeFallback: true,
      showWireOnlyMesh: false,
      showPoints: false,
    });
  });

  it("renders surface without edges geometry", () => {
    expect(
      resolveFemGeometryRenderPasses({
        renderMode: "surface",
        hasGeometry: true,
        hasEdgesGeometry: false,
        showSurfacePass: true,
        showSurfaceHiddenEdgesPass: true,
        showSurfaceVisibleEdgesPass: true,
        showPointsPass: true,
      }),
    ).toMatchObject({
      showSurface: true,
      showWireOnlyEdges: false,
      showWireOnlyMesh: false,
      showSurfaceEdges: false,
      showPoints: false,
    });
  });

  it("keeps points mode isolated from surface and wireframe passes", () => {
    expect(
      resolveFemGeometryRenderPasses({
        renderMode: "points",
        hasGeometry: true,
        hasEdgesGeometry: true,
        showSurfacePass: true,
        showSurfaceHiddenEdgesPass: true,
        showSurfaceVisibleEdgesPass: true,
        showPointsPass: true,
      }),
    ).toMatchObject({
      showSurface: false,
      showWireOnlyEdges: false,
      showWireOnlyMesh: false,
      showSurfaceEdges: false,
      showPoints: true,
    });
  });

  it("honors diagnostic surface and points pass gates", () => {
    expect(
      resolveFemGeometryRenderPasses({
        renderMode: "surface",
        hasGeometry: true,
        hasEdgesGeometry: false,
        showSurfacePass: false,
        showSurfaceHiddenEdgesPass: true,
        showSurfaceVisibleEdgesPass: true,
        showPointsPass: true,
      }),
    ).toMatchObject({
      showSurface: false,
      showPoints: false,
    });

    expect(
      resolveFemGeometryRenderPasses({
        renderMode: "points",
        hasGeometry: true,
        hasEdgesGeometry: false,
        showSurfacePass: true,
        showSurfaceHiddenEdgesPass: true,
        showSurfaceVisibleEdgesPass: true,
        showPointsPass: false,
      }),
    ).toMatchObject({
      showSurface: false,
      showPoints: false,
    });
  });

  it("activates mesh edges in legacy mesh render mode without shaded surface", () => {
    expect(
      resolveFemGeometryRenderPasses({
        renderMode: "mesh",
        hasGeometry: true,
        hasEdgesGeometry: true,
        showSurfacePass: true,
        showSurfaceHiddenEdgesPass: true,
        showSurfaceVisibleEdgesPass: true,
        showPointsPass: true,
      }),
    ).toMatchObject({
      showSurface: false,
      showMeshEdges: true,
      showWireOnlyEdges: false,
      showWireOnlyMesh: false,
      showSurfaceEdges: false,
      showPoints: false,
    });
  });

  it("disables mesh edges when no geometry is available", () => {
    expect(
      resolveFemGeometryRenderPasses({
        renderMode: "mesh",
        hasGeometry: false,
        hasEdgesGeometry: false,
        showSurfacePass: true,
        showSurfaceHiddenEdgesPass: true,
        showSurfaceVisibleEdgesPass: true,
        showPointsPass: true,
      }),
    ).toMatchObject({
      showSurface: false,
      showMeshEdges: false,
    });
  });

  it("mesh mode keeps volume edges independent of the surface pass gate", () => {
    expect(
      resolveFemGeometryRenderPasses({
        renderMode: "mesh",
        hasGeometry: true,
        hasEdgesGeometry: true,
        showSurfacePass: false,
        showSurfaceHiddenEdgesPass: true,
        showSurfaceVisibleEdgesPass: true,
        showPointsPass: true,
      }),
    ).toMatchObject({
      showSurface: false,
      showMeshEdges: true,
    });
  });

  it("keeps surface wireframe on surface edges only", () => {
    expect(
      resolveFemGeometryRenderPasses({
        renderMode: "wireframe",
        edgeScope: "surface",
        hasGeometry: true,
        hasEdgesGeometry: true,
        hasTetraEdgesGeometry: true,
        showSurfacePass: true,
        showSurfaceHiddenEdgesPass: true,
        showSurfaceVisibleEdgesPass: true,
        showPointsPass: true,
      }),
    ).toMatchObject({
      showSurface: false,
      showWireOnlyEdges: true,
      showMeshEdges: false,
    });
  });

  it("renders full wireframe as tetra edges without shaded surface", () => {
    expect(
      resolveFemGeometryRenderPasses({
        renderMode: "wireframe",
        edgeScope: "full",
        hasGeometry: true,
        hasEdgesGeometry: true,
        hasTetraEdgesGeometry: true,
        showSurfacePass: true,
        showSurfaceHiddenEdgesPass: true,
        showSurfaceVisibleEdgesPass: true,
        showPointsPass: true,
      }),
    ).toMatchObject({
      showSurface: false,
      showWireOnlyEdges: false,
      showWireOnlyMesh: false,
      showMeshEdges: true,
    });
  });

  it("renders shaded plus full wireframe as surface and tetra edges", () => {
    expect(
      resolveFemGeometryRenderPasses({
        renderMode: "surface+edges",
        edgeScope: "full",
        hasGeometry: true,
        hasEdgesGeometry: true,
        hasTetraEdgesGeometry: true,
        showSurfacePass: true,
        showSurfaceHiddenEdgesPass: true,
        showSurfaceVisibleEdgesPass: true,
        showPointsPass: true,
      }),
    ).toMatchObject({
      showSurface: true,
      showSurfaceEdges: true,
      showMeshEdges: true,
    });
  });

  it("marks full points as volume points", () => {
    expect(
      resolveFemGeometryRenderPasses({
        renderMode: "points",
        pointsScope: "full",
        hasGeometry: true,
        hasEdgesGeometry: true,
        showSurfacePass: true,
        showSurfaceHiddenEdgesPass: true,
        showSurfaceVisibleEdgesPass: true,
        showPointsPass: true,
      }),
    ).toMatchObject({
      showPoints: true,
      showFullPoints: true,
    });
  });
});
