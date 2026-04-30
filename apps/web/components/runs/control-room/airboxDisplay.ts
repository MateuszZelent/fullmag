import type {
  AirboxDisplayPatch,
  AirboxDisplayScope,
  ViewportMeshRenderMode,
} from "@/components/shell/ribbon/command-registry";

export interface AirboxDisplayState {
  geometryVisible: boolean;
  surface: boolean;
  wireframe: boolean;
  points: boolean;
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
      surface: false,
      wireframe: true,
      points: false,
      renderMode: "wireframe",
      wireframeScope: "full",
      pointsScope: "surface",
      vectorsScope: "surface",
    };
  }
  return {
    geometryVisible: true,
    surface: renderMode === "surface" || renderMode === "surface+edges",
    wireframe: renderMode === "wireframe" || renderMode === "surface+edges",
    points: renderMode === "points",
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
    surface: current.surface,
    wireframe: current.wireframe,
    points: current.points,
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

  let shaded = base.surface;
  let wireframe = base.wireframe;
  let points = base.points;

  if (typeof patch.points === "boolean") {
    points = patch.points;
  }
  if (typeof patch.shaded === "boolean") {
    shaded = patch.shaded;
  }
  if (typeof patch.wireframe === "boolean") {
    wireframe = patch.wireframe;
  }

  let geometryVisible =
    typeof patch.geometry === "boolean" ? patch.geometry : base.geometryVisible;
  if (patch.geometry === false) {
    shaded = false;
    wireframe = false;
    points = false;
  }
  if (!shaded && !wireframe && !points) {
    geometryVisible = false;
  } else if (
    patch.geometry === true ||
    patch.shaded === true ||
    patch.wireframe === true ||
    patch.points === true ||
    patch.renderMode
  ) {
    geometryVisible = true;
  }

  const renderMode: ViewportMeshRenderMode = points
    ? shaded || wireframe
      ? shaded && wireframe
        ? "surface+edges"
        : shaded
          ? "surface"
          : "wireframe"
      : "points"
    : shaded && wireframe
      ? "surface+edges"
      : shaded
        ? "surface"
        : wireframe
          ? "wireframe"
          : base.renderMode;

  return {
    geometryVisible,
    surface: shaded,
    wireframe,
    points,
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
