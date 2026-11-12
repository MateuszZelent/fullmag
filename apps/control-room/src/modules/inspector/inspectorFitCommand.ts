/**
 * Command behind the Inspector footer "Fit view": it fits the main viewport
 * the user is looking at, so the 2D view fits its plane instead of the 3D camera.
 */
export function inspectorFitCommandId(activeViewportMainModuleId: string | null | undefined): string {
  return activeViewportMainModuleId === "field-map" ? "field-map.fit" : "viewport-3d.fit";
}
