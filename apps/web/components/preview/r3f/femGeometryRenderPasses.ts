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
  /** Show internal (volume) mesh edges — active in "mesh" render mode. */
  showMeshEdges: boolean;
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
  const isSurfaceMode = renderMode === "surface" || renderMode === "surface+edges";
  const showSurface = showSurfacePass && isSurfaceMode;

  // Wireframe: prefer dedicated WireframeGeometry (clean lines via lineSegments),
  // but ALWAYS fall back to material wireframe so we never show nothing.
  const showWireOnlyEdges = renderMode === "wireframe" && hasEdgesGeometry;
  const showWireOnlyMesh = renderMode === "wireframe" && hasGeometry;

  const showSurfaceEdges = renderMode === "surface+edges" && hasEdgesGeometry;
  const showSurfaceEdgeFallback =
    showSurfaceEdges && !showSurfaceHiddenEdgesPass && !showSurfaceVisibleEdgesPass;

  // "mesh" mode — show surface as transparent ghost + volume wireframe edges
  const showMeshEdges = renderMode === "mesh" && hasGeometry;

  return {
    showSurface: showSurface || (renderMode === "mesh" && hasGeometry && showSurfacePass),
    showWireOnlyEdges,
    showWireOnlyMesh: showWireOnlyMesh && !showWireOnlyEdges,
    showSurfaceEdges,
    showSurfaceEdgeFallback,
    showPoints: showPointsPass && renderMode === "points",
    showMeshEdges,
  };
}
