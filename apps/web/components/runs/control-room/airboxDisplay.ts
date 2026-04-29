import type {
  AirboxDisplayPatch,
  ViewportMeshRenderMode,
} from "@/components/shell/ribbon/command-registry";

export function resolveAirboxRenderMode(
  currentMode: ViewportMeshRenderMode,
  patch: AirboxDisplayPatch,
): ViewportMeshRenderMode {
  if (patch.renderMode) {
    return patch.renderMode;
  }
  let shaded = currentMode === "surface" || currentMode === "surface+edges";
  let wireframe = currentMode === "wireframe" || currentMode === "surface+edges";
  let points = currentMode === "points";

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

  if (!shaded && !wireframe && !points) {
    if (patch.wireframe === false) {
      shaded = true;
    } else {
      wireframe = true;
    }
  }

  if (points) return "points";
  if (shaded && wireframe) return "surface+edges";
  if (shaded) return "surface";
  return "wireframe";
}
