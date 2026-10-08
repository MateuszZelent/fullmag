import type { VisualizationTargetSettings } from "./ObjectVisualizationController";

/** Presentation only; the authored role never determines solver physics. */
export function resolvePrimitiveSurfaceColor(
  role: string | null | undefined,
  settings: Pick<VisualizationTargetSettings, "primitiveMonoColor" | "shaderMonoColor" | "surfaceColorSource">,
): {
  color: string;
  source: "primitive" | "solid-shader" | "antenna-theme" | "object-theme";
} {
  const solid = settings.surfaceColorSource === "solid";
  const requested = solid ? settings.shaderMonoColor : settings.primitiveMonoColor;
  if (requested && !requested.startsWith("var(")) {
    return { color: requested, source: solid ? "solid-shader" : "primitive" };
  }
  return role === "antenna"
    ? { color: "var(--fm-surface-antenna)", source: "antenna-theme" }
    : { color: "var(--fm-surface-3)", source: "object-theme" };
}
