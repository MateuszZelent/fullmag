import type { MeshDisplayScope, RenderMode } from "../fem/femMeshTypes";
import type { MeshPasses } from "../../runs/control-room/meshDisplayState";

interface ResolveFemGeometryRenderPassesInput {
  renderMode: RenderMode;
  renderPasses?: FemGeometryPassState;
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

export interface FemGeometryPassState {
  surface: boolean;
  wireframe: boolean;
  volumeMesh: boolean;
  points: boolean;
}

// ── Bridge: FemGeometryPassState ↔ MeshPasses ────────────────────────────────
// Converts between the renderer-facing pass state (`wireframe`, `volumeMesh`)
// and the canonical `MeshPasses` (`surfaceEdges`, `volumeEdges`).

/** Convert canonical `MeshPasses` → renderer `FemGeometryPassState`. */
export function femPassStateFromMeshPasses(passes: MeshPasses): FemGeometryPassState {
  return {
    surface: passes.surface,
    wireframe: passes.surfaceEdges,
    volumeMesh: passes.volumeEdges,
    points: passes.points,
  };
}

/** Convert renderer `FemGeometryPassState` → canonical `MeshPasses`. */
export function meshPassesFromFemPassState(passes: FemGeometryPassState): MeshPasses {
  return {
    surface: passes.surface,
    surfaceEdges: passes.wireframe,
    volumeEdges: passes.volumeMesh,
    points: passes.points,
  };
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
  renderPasses,
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
  if (renderPasses) {
    const showSurface = showSurfacePass && renderPasses.surface;
    const showWireframe = renderPasses.wireframe;
    const fullWireframe = showWireframe && edgeScope === "full";
    const showWireOnlyEdges =
      showWireframe && !showSurface && hasEdgesGeometry && !fullWireframe;
    const showWireOnlyMesh =
      showWireframe && !showSurface && hasGeometry && !fullWireframe;
    const showSurfaceEdges = showWireframe && showSurface && hasEdgesGeometry;
    const showSurfaceEdgeFallback =
      showSurfaceEdges && !showSurfaceHiddenEdgesPass && !showSurfaceVisibleEdgesPass;
    const showMeshEdges =
      (renderPasses.volumeMesh && hasGeometry) ||
      (showWireframe && edgeScope === "full" && (hasTetraEdgesGeometry || hasGeometry));
    const showPoints = showPointsPass && renderPasses.points;

    return {
      showSurface,
      showWireOnlyEdges,
      showWireOnlyMesh: showWireOnlyMesh && !showWireOnlyEdges,
      showSurfaceEdges,
      showSurfaceEdgeFallback,
      showPoints,
      showMeshEdges,
      showFullPoints: showPoints && pointsScope === "full",
    };
  }

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
