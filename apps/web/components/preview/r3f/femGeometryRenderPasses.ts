import type { MeshDisplayScope, RenderMode } from "../fem/femMeshTypes";

interface ResolveFemGeometryRenderPassesInput {
  renderMode: RenderMode;
  edgeScope?: MeshDisplayScope;
  pointsScope?: MeshDisplayScope;
  hasGeometry: boolean;
  hasEdgesGeometry: boolean;
  hasTetraEdgesGeometry?: boolean;
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
  showFullPoints: boolean;
}

export function resolveFemGeometryRenderPasses({
  renderMode,
  edgeScope = "surface",
  pointsScope = "surface",
  hasGeometry,
  hasEdgesGeometry,
  hasTetraEdgesGeometry = false,
  showSurfacePass,
  showSurfaceHiddenEdgesPass,
  showSurfaceVisibleEdgesPass,
  showPointsPass,
}: ResolveFemGeometryRenderPassesInput): FemGeometryRenderPasses {
  const isSurfaceMode = renderMode === "surface" || renderMode === "surface+edges";
  const showSurface = showSurfacePass && isSurfaceMode;

  // Wireframe: prefer dedicated WireframeGeometry (clean lines via lineSegments),
  // but ALWAYS fall back to material wireframe so we never show nothing.
  const fullWireframe = renderMode === "wireframe" && edgeScope === "full";
  const showWireOnlyEdges = renderMode === "wireframe" && hasEdgesGeometry && !fullWireframe;
  const showWireOnlyMesh = renderMode === "wireframe" && hasGeometry && !fullWireframe;

  const showSurfaceEdges = renderMode === "surface+edges" && hasEdgesGeometry;
  const showSurfaceEdgeFallback =
    showSurfaceEdges && !showSurfaceHiddenEdgesPass && !showSurfaceVisibleEdgesPass;

  // "mesh" mode is a legacy preset for volume wireframe edges. Do not add a
  // transparent surface here; shaded airbox surface is controlled separately by
  // the "Shaded on/off" primitive toggle.
  const showMeshEdges =
    (renderMode === "mesh" && hasGeometry) ||
    ((renderMode === "wireframe" || renderMode === "surface+edges") &&
      edgeScope === "full" &&
      (hasTetraEdgesGeometry || hasGeometry));
  const showFullPoints = showPointsPass && renderMode === "points" && pointsScope === "full";

  return {
    showSurface,
    showWireOnlyEdges,
    showWireOnlyMesh: showWireOnlyMesh && !showWireOnlyEdges,
    showSurfaceEdges,
    showSurfaceEdgeFallback,
    showPoints: showPointsPass && renderMode === "points",
    showMeshEdges,
    showFullPoints,
  };
}
