import type { RenderMode } from "../fem/femMeshTypes";

interface ResolveFemGeometryRenderPassesInput {
  renderMode: RenderMode;
  hasGeometry: boolean;
  hasEdgesGeometry: boolean;
  showSurfacePass: boolean;
  showSurfaceHiddenEdgesPass: boolean;
  showSurfaceVisibleEdgesPass: boolean;
  showPointsPass: boolean;
}

export interface FemGeometryRenderPasses {
  showSurface: boolean;
  showWireOnlyEdges: boolean;
  showWireOnlyMesh: boolean;
  showSurfaceEdges: boolean;
  showSurfaceEdgeFallback: boolean;
  showPoints: boolean;
}

export function resolveFemGeometryRenderPasses({
  renderMode,
  hasGeometry,
  hasEdgesGeometry,
  showSurfacePass,
  showSurfaceHiddenEdgesPass,
  showSurfaceVisibleEdgesPass,
  showPointsPass,
}: ResolveFemGeometryRenderPassesInput): FemGeometryRenderPasses {
  const showSurface = showSurfacePass && (renderMode === "surface" || renderMode === "surface+edges");
  const showWireOnlyEdges = renderMode === "wireframe" && hasEdgesGeometry;
  const showWireOnlyMesh = renderMode === "wireframe" && hasGeometry;
  const showSurfaceEdges = renderMode === "surface+edges" && hasEdgesGeometry;
  const showSurfaceEdgeFallback =
    showSurfaceEdges && !showSurfaceHiddenEdgesPass && !showSurfaceVisibleEdgesPass;

  return {
    showSurface,
    showWireOnlyEdges,
    showWireOnlyMesh: showWireOnlyMesh && !showWireOnlyEdges,
    showSurfaceEdges,
    showSurfaceEdgeFallback,
    showPoints: showPointsPass && renderMode === "points",
  };
}
