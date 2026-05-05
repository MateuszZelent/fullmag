export type Viewport3DRolloutRoute =
  | "minimal-diagnostic"
  | "geometry-authoring"
  | "fem-3d"
  | "fem-mesh"
  | "fem-bounds-fallback"
  | "fdm-3d"
  | "fdm-mesh"
  | "slice-2d"
  | "analyze"
  | "empty";

export interface Viewport3DRolloutRouteInput {
  minimalViewportSelectionPath: boolean;
  showGeometryAuthoringViewport: boolean;
  femDiscretization: boolean;
  effectiveViewMode: "3D" | "2D" | "Mesh" | "Analyze";
  hasFemMeshData: boolean;
  showFemBoundsPreview: boolean;
  showVectorSurface3D: boolean;
  isVectorSurfaceMeshActive: boolean;
  cutover: boolean;
}

export interface Viewport3DRolloutRouteState {
  route: Viewport3DRolloutRoute;
  fallbackUsed: boolean;
  signature: string;
}

export function resolveViewport3DRolloutRoute({
  minimalViewportSelectionPath,
  showGeometryAuthoringViewport,
  femDiscretization,
  effectiveViewMode,
  hasFemMeshData,
  showFemBoundsPreview,
  showVectorSurface3D,
  isVectorSurfaceMeshActive,
  cutover,
}: Viewport3DRolloutRouteInput): Viewport3DRolloutRouteState {
  let route: Viewport3DRolloutRoute = "empty";
  let fallbackUsed = false;
  if (minimalViewportSelectionPath) {
    route = "minimal-diagnostic";
  } else if (showGeometryAuthoringViewport) {
    route = "geometry-authoring";
  } else if (femDiscretization && (effectiveViewMode === "3D" || effectiveViewMode === "Mesh")) {
    if (!hasFemMeshData && showFemBoundsPreview) {
      route = "fem-bounds-fallback";
      fallbackUsed = true;
    } else {
      route = effectiveViewMode === "Mesh" ? "fem-mesh" : "fem-3d";
    }
  } else if (showVectorSurface3D) {
    route = isVectorSurfaceMeshActive ? "fdm-mesh" : "fdm-3d";
  } else if (effectiveViewMode === "2D") {
    route = "slice-2d";
  } else if (effectiveViewMode === "Analyze") {
    route = "analyze";
  }
  return {
    route,
    fallbackUsed,
    signature: `${route}|${fallbackUsed ? "fallback" : "primary"}|${cutover ? "cutover" : "staged"}`,
  };
}
