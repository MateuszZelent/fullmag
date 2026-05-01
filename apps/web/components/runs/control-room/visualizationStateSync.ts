import type { RenderMode } from "@/components/preview/FemMeshView3D";
import type {
  ClipAxis,
  FemArrowColorMode,
  FemFerromagnetVisibilityMode,
} from "@/components/preview/fem/femMeshTypes";
import type {
  AirboxRenderPassState,
  FemViewportLayerState,
  MeshRenderPassState,
} from "@/features/viewport-unified/model/unifiedViewportTypes";
import type { Slice2DToolbarState } from "@/src/features/slice2d";
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

export interface ResolvedRenderPlan {
  quantity: {
    activeQuantityId: string;
    fieldComponent: VisualizationStateResource["quantity"]["field_component"];
    colormap: string;
    autoContrast: boolean;
  };
  layers: {
    renderMode: RenderMode;
    meshOpacityPercent: number;
    vectorsVisible: boolean;
    vectorDomainFilter: FemVectorDomainFilter | null;
    femLayers: FemViewportLayerState;
    passes: MeshRenderPassState;
    airbox: AirboxRenderPassState;
    /**
     * Compatibility mirrors for consumers that still expect scalar airbox fields.
     * New renderer code should consume layers.airbox.
     */
    airboxVisible: boolean;
    airboxOpacityPercent: number;
  };
  sampling: {
    maxPoints: number;
    maxGlyphs: number;
    profile: VisualizationStateResource["sampling"]["profile"];
    progressive: boolean;
  };
  clip: {
    enabled: boolean;
    axis: ClipAxis;
    positionPercent: number;
    flipped: boolean;
  };
  vectorStyle: {
    colorMode: FemArrowColorMode;
    monoColor: string;
    alpha: number;
    lengthScale: number;
    thickness: number;
    ferromagnetVisibility: FemFerromagnetVisibilityMode;
  };
  slice: Slice2DToolbarState;
  diagnostics: VisualizationStateResource["diagnostics"];
}

export interface ViewportVisualizationState {
  meshRenderMode: RenderMode;
  meshOpacity: number;
  meshClipEnabled: boolean;
  meshClipAxis: ClipAxis;
  meshClipPos: number;
  meshClipFlip: boolean;
  meshShowArrows: boolean;
  femVectorGlyphBudget: number;
  femArrowColorMode: FemArrowColorMode;
  femArrowMonoColor: string;
  femArrowAlpha: number;
  femArrowLengthScale: number;
  femArrowThickness: number;
  femVectorDomainFilter: FemVectorDomainFilter;
  femFerromagnetVisibilityMode: FemFerromagnetVisibilityMode;
  femViewportLayers: FemViewportLayerState;
  airMeshVisible: boolean;
  airMeshOpacity: number;
}

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

export function renderPassesFromVisualizationState(
  state: VisualizationStateResource,
): MeshRenderPassState {
  return {
    surface: state.layers.surface.visible,
    wireframe: state.layers.wireframe.visible,
    volumeMesh: state.layers.volume_mesh.visible,
    points: state.layers.points.visible,
    vectors: state.layers.vectors.visible,
    quantityOverlay: state.layers.quantity_overlay.visible,
  };
}

export function airboxPassesFromVisualizationState(
  state: VisualizationStateResource,
): AirboxRenderPassState {
  return {
    visible: state.layers.airbox.visible,
    surface: state.layers.airbox.surface.visible,
    wireframe: state.layers.airbox.wireframe.visible,
    points: state.layers.airbox.points.visible,
    vectors: state.layers.airbox.vectors.visible,
    opacityPercent: opacityUnitToPercent(state.layers.airbox.opacity, 28),
  };
}

export function sliceToolbarFromVisualizationState(
  state: VisualizationStateResource,
): Slice2DToolbarState {
  return {
    quantityId: state.slice.quantity_id,
    component: state.slice.component,
    axis: state.slice.axis,
    mode: state.slice.mode,
    layerIndex: state.slice.layer_index,
    positionPercent: state.slice.position_percent,
    thicknessPercent: state.slice.thickness_percent,
    colormap: state.slice.colormap,
    autoContrast: state.slice.auto_contrast,
    showPrimitives: state.slice.show_primitives,
    showMesh: state.slice.show_mesh,
    showMagneticTexture: state.slice.show_magnetic_texture,
    showAirbox: state.slice.show_airbox,
    airboxRenderMode: state.slice.airbox_render_mode,
    showAirboxVectors: state.slice.show_airbox_vectors,
    showQuantity: state.slice.show_quantity,
    showVectors: state.slice.show_vectors,
    renderMode: state.slice.render_mode,
  };
}

export function resolveRenderPlanFromVisualizationState(
  state: VisualizationStateResource,
  previousFemLayers: FemViewportLayerState,
): ResolvedRenderPlan {
  const airbox = airboxPassesFromVisualizationState(state);
  return {
    quantity: {
      activeQuantityId: state.quantity.active_quantity_id,
      fieldComponent: state.quantity.field_component,
      colormap: state.quantity.colormap,
      autoContrast: state.quantity.auto_contrast,
    },
    layers: {
      renderMode: renderModeFromVisualizationState(state),
      meshOpacityPercent: opacityUnitToPercent(state.layers.surface.opacity, 100),
      vectorsVisible: state.layers.vectors.visible,
      vectorDomainFilter: femVectorDomainFromVisualizationState(state.layers.vectors.domain),
      femLayers: femLayersFromVisualizationState(state, previousFemLayers),
      passes: renderPassesFromVisualizationState(state),
      airbox,
      airboxVisible: airbox.visible,
      airboxOpacityPercent: airbox.opacityPercent,
    },
    sampling: {
      maxPoints: state.sampling.max_points,
      maxGlyphs: state.sampling.max_glyphs,
      profile: state.sampling.profile,
      progressive: state.sampling.progressive,
    },
    clip: {
      enabled: state.clip.enabled,
      axis: clipAxisFromVisualizationState(state.clip.axis),
      positionPercent: state.clip.position_percent,
      flipped: state.clip.flipped,
    },
    vectorStyle: {
      colorMode: vectorColorModeFromVisualizationState(state.vector_style.color_mode),
      monoColor: state.vector_style.mono_color,
      alpha: state.vector_style.alpha,
      lengthScale: state.vector_style.length_scale,
      thickness: state.vector_style.thickness,
      ferromagnetVisibility: ferromagnetVisibilityFromVisualizationState(
        state.vector_style.ferromagnet_visibility,
      ),
    },
    slice: sliceToolbarFromVisualizationState(state),
    diagnostics: state.diagnostics,
  };
}

export function projectResolvedRenderPlanToViewportState(
  plan: ResolvedRenderPlan | null,
  fallback: ViewportVisualizationState,
): ViewportVisualizationState {
  if (!plan) {
    return fallback;
  }
  return {
    meshRenderMode: plan.layers.renderMode,
    meshOpacity: plan.layers.meshOpacityPercent,
    meshClipEnabled: plan.clip.enabled,
    meshClipAxis: plan.clip.axis,
    meshClipPos: plan.clip.positionPercent,
    meshClipFlip: plan.clip.flipped,
    meshShowArrows: plan.layers.vectorsVisible,
    femVectorGlyphBudget: plan.sampling.maxGlyphs,
    femArrowColorMode: plan.vectorStyle.colorMode,
    femArrowMonoColor: plan.vectorStyle.monoColor,
    femArrowAlpha: plan.vectorStyle.alpha,
    femArrowLengthScale: plan.vectorStyle.lengthScale,
    femArrowThickness: plan.vectorStyle.thickness,
    femVectorDomainFilter: plan.layers.vectorDomainFilter ?? fallback.femVectorDomainFilter,
    femFerromagnetVisibilityMode: plan.vectorStyle.ferromagnetVisibility,
    femViewportLayers: plan.layers.femLayers,
    airMeshVisible: plan.layers.airboxVisible,
    airMeshOpacity: plan.layers.airboxOpacityPercent,
  };
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
