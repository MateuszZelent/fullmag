import type {
  AirboxDisplayPatch,
  AirboxDisplayScope,
  ViewportMeshRenderMode,
} from "@/components/shell/ribbon/command-registry";

export interface AirboxDisplayState {
  geometryVisible: boolean;
  renderMode: ViewportMeshRenderMode;
  wireframeScope: AirboxDisplayScope;
  pointsScope: AirboxDisplayScope;
  vectorsScope: AirboxDisplayScope;
}

export function airboxDisplayStateFromRenderMode(
  renderMode: ViewportMeshRenderMode,
): AirboxDisplayState {
  if (renderMode === "mesh") {
    return {
      geometryVisible: true,
      renderMode: "wireframe",
      wireframeScope: "full",
      pointsScope: "surface",
      vectorsScope: "surface",
    };
  }
  return {
    geometryVisible: true,
    renderMode,
    wireframeScope: "surface",
    pointsScope: "surface",
    vectorsScope: "surface",
  };
}

export function resolveAirboxDisplayState(
  current: AirboxDisplayState,
  patch: AirboxDisplayPatch,
): AirboxDisplayState {
  const modeDefaults = airboxDisplayStateFromRenderMode(current.renderMode);
  const normalizedCurrent = {
    ...modeDefaults,
    geometryVisible: current.geometryVisible,
    wireframeScope:
      current.renderMode === "mesh"
        ? modeDefaults.wireframeScope
        : current.wireframeScope,
    pointsScope: current.pointsScope,
    vectorsScope: current.vectorsScope,
  };
  const base = patch.renderMode
    ? {
        ...normalizedCurrent,
        ...airboxDisplayStateFromRenderMode(patch.renderMode),
      }
    : normalizedCurrent;

  let shaded = base.renderMode === "surface" || base.renderMode === "surface+edges";
  let wireframe = base.renderMode === "wireframe" || base.renderMode === "surface+edges";
  let points = base.renderMode === "points";

  if (typeof patch.points === "boolean") {
    points = patch.points;
    if (points) {
      shaded = false;
      wireframe = false;
    }
  }
  if (typeof patch.shaded === "boolean") {
    shaded = patch.shaded;
    if (shaded) points = false;
  }
  if (typeof patch.wireframe === "boolean") {
    wireframe = patch.wireframe;
    if (wireframe) points = false;
  }

  let geometryVisible =
    typeof patch.geometry === "boolean" ? patch.geometry : base.geometryVisible;
  if (!shaded && !wireframe && !points) {
    geometryVisible = false;
  } else if (
    patch.shaded === true ||
    patch.wireframe === true ||
    patch.points === true ||
    patch.renderMode
  ) {
    geometryVisible = true;
  }

  const renderMode: ViewportMeshRenderMode = points
    ? "points"
    : shaded && wireframe
      ? "surface+edges"
      : shaded
        ? "surface"
        : "wireframe";

  return {
    geometryVisible,
    renderMode,
    wireframeScope: patch.wireframeScope ?? base.wireframeScope,
    pointsScope: patch.pointsScope ?? base.pointsScope,
    vectorsScope: patch.vectorsScope ?? base.vectorsScope,
  };
}

export function resolveAirboxRenderMode(
  currentMode: ViewportMeshRenderMode,
  patch: AirboxDisplayPatch,
): ViewportMeshRenderMode {
  return resolveAirboxDisplayState(
    { ...airboxDisplayStateFromRenderMode(currentMode), geometryVisible: true },
    patch,
  ).renderMode;
}
