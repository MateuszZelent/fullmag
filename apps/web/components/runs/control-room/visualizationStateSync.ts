import type { RenderMode } from "@/components/preview/FemMeshView3D";
import type {
  ClipAxis,
  FemArrowColorMode,
  FemFerromagnetVisibilityMode,
} from "@/components/preview/fem/femMeshTypes";
import type { FemViewportLayerState } from "@/features/viewport-unified/model/unifiedViewportTypes";
import type {
  FerromagnetVisibilityMode,
  VectorLayerDomain,
  VectorColorMode,
  VisualizationStatePatch,
  VisualizationStateResource,
} from "@/src/api/types";

export type FemVectorDomainFilter =
  | "auto"
  | "magnetic_only"
  | "full_domain"
  | "airbox_only";

export function clipAxisFromVisualizationState(axis: "x" | "y" | "z"): ClipAxis {
  return axis;
}

export function vectorColorModeFromVisualizationState(
  mode: VectorColorMode,
): FemArrowColorMode {
  return mode;
}

export function ferromagnetVisibilityFromVisualizationState(
  mode: FerromagnetVisibilityMode,
): FemFerromagnetVisibilityMode {
  return mode;
}

export function opacityUnitToPercent(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const percent = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

export function renderModeFromVisualizationState(
  state: VisualizationStateResource,
): RenderMode {
  if (state.layers.points.visible) {
    return "points";
  }
  if (state.layers.volume_mesh.visible || state.fem.topology_mode === "volume") {
    return "mesh";
  }
  if (state.layers.surface.visible && state.layers.wireframe.visible) {
    return "surface+edges";
  }
  if (state.layers.wireframe.visible || state.fem.topology_mode === "boundary") {
    return "wireframe";
  }
  return "surface";
}

export function femLayersFromVisualizationState(
  state: VisualizationStateResource,
  previous: FemViewportLayerState,
): FemViewportLayerState {
  const showMesh =
    state.layers.wireframe.visible ||
    state.layers.volume_mesh.visible ||
    state.layers.points.visible;
  return {
    showPrimitives: state.layers.primitives.visible,
    showMesh,
    showMagneticTexture: previous.showMagneticTexture,
    showQuantity: state.layers.quantity_overlay.visible,
  };
}

export function femVectorDomainFromVisualizationState(
  domain: VectorLayerDomain,
): FemVectorDomainFilter | null {
  switch (domain) {
    case "auto":
    case "magnetic_only":
    case "full_domain":
    case "airbox_only":
      return domain;
    default:
      return null;
  }
}

export function visualizationPatchForRenderMode(
  renderMode: RenderMode,
): VisualizationStatePatch {
  return {
    layers: {
      surface: {
        visible: renderMode === "surface" || renderMode === "surface+edges",
      },
      wireframe: {
        visible: renderMode === "wireframe" || renderMode === "surface+edges",
      },
      volume_mesh: {
        visible: renderMode === "mesh",
      },
      points: {
        visible: renderMode === "points",
      },
    },
    fem: {
      topology_mode:
        renderMode === "mesh"
          ? "volume"
          : renderMode === "wireframe" || renderMode === "surface+edges"
            ? "boundary"
            : "surface",
    },
  };
}

export function visualizationPatchForOpacity(
  opacityPercent: number,
): VisualizationStatePatch {
  const opacity = Math.max(0, Math.min(100, opacityPercent)) / 100;
  return {
    layers: {
      surface: { opacity },
      quantity_overlay: { opacity },
    },
  };
}

export function visualizationPatchForFemLayers(
  layers: FemViewportLayerState,
): VisualizationStatePatch {
  return {
    layers: {
      primitives: {
        visible: layers.showPrimitives,
      },
      quantity_overlay: {
        visible: layers.showQuantity,
      },
      wireframe: {
        visible: layers.showMesh,
      },
    },
  };
}

export function visualizationPatchForClip(
  patch: Partial<{
    enabled: boolean;
    axis: ClipAxis;
    positionPercent: number;
    flipped: boolean;
  }>,
): VisualizationStatePatch {
  return {
    clip: {
      enabled: patch.enabled,
      axis: patch.axis,
      position_percent: patch.positionPercent,
      flipped: patch.flipped,
    },
  };
}

export function visualizationPatchForVectorStyle(
  patch: Partial<{
    colorMode: FemArrowColorMode;
    monoColor: string;
    alpha: number;
    lengthScale: number;
    thickness: number;
    ferromagnetVisibility: FemFerromagnetVisibilityMode;
  }>,
): VisualizationStatePatch {
  return {
    vector_style: {
      color_mode: patch.colorMode,
      mono_color: patch.monoColor,
      alpha: patch.alpha,
      length_scale: patch.lengthScale,
      thickness: patch.thickness,
      ferromagnet_visibility: patch.ferromagnetVisibility,
    },
  };
}
