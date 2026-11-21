import type { ModeCompositionLayer, ModeFieldComponent, ModeFieldRepresentation } from "@/kernel/visualization/ModeCompositionController";

export function legalModeLayerComponents(
  representation: ModeFieldRepresentation,
): readonly ModeFieldComponent[] {
  if (representation === "phase") return ["x", "y", "z"];
  if (representation === "abs") return ["x", "y", "z", "magnitude"];
  return ["x", "y", "z", "magnitude", "vector"];
}

export function eigenModeLayerAppearanceDefaults(
  representation: ModeFieldRepresentation,
): ModeCompositionLayer["appearance"] {
  if (representation === "phase") {
    return {
      auto_range: false,
      colorbar_visible: true,
      colormap: "twilight",
      opacity: 1,
      range_max: Math.PI,
      range_min: -Math.PI,
      symmetric_zero: false,
      vector_budget: 512,
      vector_length_scale: 1,
      vectors_visible: false,
    };
  }
  if (representation === "abs") {
    return {
      auto_range: true,
      colorbar_visible: true,
      colormap: "viridis",
      opacity: 1,
      symmetric_zero: false,
      vector_budget: 512,
      vector_length_scale: 1,
      vectors_visible: false,
    };
  }
  return {
    auto_range: true,
    colorbar_visible: true,
    colormap: "coolwarm",
    opacity: 1,
    symmetric_zero: true,
    vector_budget: 512,
    vector_length_scale: 1,
    vectors_visible: false,
  };
}
