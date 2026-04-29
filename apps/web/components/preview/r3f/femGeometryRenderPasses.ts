import type { RenderMode } from "../fem/femMeshTypes";

interface ResolveFemGeometryRenderPassesInput {
  renderMode: RenderMode;
  hasGeometry: boolean;
  hasEdgesGeometry: boolean;
  showSurfaceHiddenEdgesPass: boolean;
  showSurfaceVisibleEdgesPass: boolean;
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
  showSurfaceHiddenEdgesPass,
  showSurfaceVisibleEdgesPass,
}: ResolveFemGeometryRenderPassesInput): FemGeometryRenderPasses {
  const showSurface = renderMode === "surface" || renderMode === "surface+edges";
  const showWireOnlyEdges = renderMode === "wireframe" && hasEdgesGeometry;
  const showWireOnlyMesh = renderMode === "wireframe" && hasGeometry && !hasEdgesGeometry;
  const showSurfaceEdges = renderMode === "surface+edges" && hasEdgesGeometry;
  const showSurfaceEdgeFallback =
    showSurfaceEdges && !showSurfaceHiddenEdgesPass && !showSurfaceVisibleEdgesPass;

  return {
    showSurface,
    showWireOnlyEdges,
    showWireOnlyMesh,
    showSurfaceEdges,
    showSurfaceEdgeFallback,
    showPoints: renderMode === "points",
  };
}
