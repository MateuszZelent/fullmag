import type {
  CapabilityMap,
  DisplaySelection,
  FieldComponent,
  FieldProjectionQuery,
  FieldSliceQuery,
  ResourceRevisionMap,
} from "../../api/types";
import {
  domainRevisionStateFromResources,
  quantitySelectionFromDisplay,
  sharedCapabilitiesFromApi,
  slicePlaneFromDisplay,
  type QuantitySelectionState,
  type SliceAxis,
} from "../workspaceSync/contracts";
import type {
  Slice2DAdapter,
  Slice2DCapabilities,
  Slice2DCapabilityGateMap,
  Slice2DModel,
  Slice2DToolbarState,
  SliceBuildRequest,
  SliceFrame,
  SliceRenderMode,
} from "./types";

const DEFAULT_RENDER_MODE: SliceRenderMode = "heatmap";

export function slice2DToolbarFromDisplay(
  display: DisplaySelection,
  planeOptions?: Parameters<typeof slicePlaneFromDisplay>[1],
): Slice2DToolbarState {
  const quantity = quantitySelectionFromDisplay(display);
  const plane = slicePlaneFromDisplay(display, planeOptions);
  return {
    quantityId: quantity.activeQuantityId,
    component: quantity.component === "3D" ? "magnitude" : quantity.component,
    axis: plane.axis,
    mode: plane.mode,
    layerIndex: plane.layerIndex,
    positionPercent: plane.positionPercent,
    positionWorld: null,
    normalAxisBounds: null,
    magneticExtent: null,
    thicknessPercent: plane.thicknessPercent,
    colormap: quantity.colormap,
    autoContrast: quantity.autoContrast,
    showPrimitives: true,
    showMesh: false,
    showMagneticTexture: true,
    showAirbox: false,
    airboxRenderMode: "wireframe",
    showAirboxVectors: false,
    showQuantity: true,
    showVectors: display.vector_glyphs,
    renderMode: display.vector_glyphs ? "vectors" : DEFAULT_RENDER_MODE,
    projectionReduction: "mean_occupied",
    projectionIncludeAirAsZero: false,
    projectionSamples: 20,
    projectionResolution: display.x_chosen_size > 0 ? display.x_chosen_size : 128,
  };
}

export function slice2DCapabilitiesFromApi(
  capabilities: CapabilityMap | null | undefined,
): Slice2DCapabilities {
  const shared = sharedCapabilitiesFromApi(capabilities);
  return {
    preview_2d: shared.preview_2d,
    structured_grid: shared.structured_grid,
    explicit_topology: shared.explicit_topology,
    authoring_primitives: shared.authoring_primitives,
    slice_probe: shared.slice_probe,
    slice_measure: shared.slice_probe,
    slice_profile: shared.slice_profile,
    slice_vectors: shared.preview_2d,
    slice_all_layers: shared.structured_grid,
  };
}

export function slice2DCapabilityGates(
  capabilities: Slice2DCapabilities,
): Slice2DCapabilityGateMap {
  const reasons: Record<keyof Slice2DCapabilities, string> = {
    preview_2d: "Requires preview_2d capability",
    structured_grid: "Requires structured_grid capability",
    explicit_topology: "Requires explicit_topology capability",
    authoring_primitives: "Requires authoring_primitives capability",
    slice_probe: "Requires slice_probe capability",
    slice_measure: "Requires slice_measure capability",
    slice_profile: "Requires slice_profile capability",
    slice_vectors: "Requires slice_vectors capability",
    slice_all_layers: "Requires slice_all_layers capability",
  };
  return Object.fromEntries(
    (Object.keys(capabilities) as Array<keyof Slice2DCapabilities>).map((key) => [
      key,
      { enabled: capabilities[key], reason: capabilities[key] ? null : reasons[key] },
    ]),
  ) as Slice2DCapabilityGateMap;
}

export function buildSlice2DModel(args: {
  display: DisplaySelection;
  resources?: Partial<ResourceRevisionMap> | null;
  capabilities?: CapabilityMap | null;
  adapterKind: "fdm" | "fem";
  planeOptions?: Parameters<typeof slicePlaneFromDisplay>[1];
}): Slice2DModel {
  const quantity = quantitySelectionFromDisplay(args.display);
  const plane = slicePlaneFromDisplay(args.display, args.planeOptions);
  const toolbar = slice2DToolbarFromDisplay(args.display, args.planeOptions);
  const revisions = domainRevisionStateFromResources(args.resources);
  const capabilities = slice2DCapabilitiesFromApi(args.capabilities);
  const adapter =
    args.adapterKind === "fem"
      ? createFemSlice2DAdapter(capabilities)
      : createFdmSlice2DAdapter(capabilities);
  const frame = adapter.buildSlice({ quantity, plane, toolbar, revisions });
  const gates = slice2DCapabilityGates(capabilities);
  const stale = revisions.domainGenerationId == null || revisions.fieldsRevision == null;

  return {
    quantity,
    plane,
    toolbar,
    overlays: {
      showPrimitives: toolbar.showPrimitives,
      showMesh: toolbar.showMesh,
      showMagneticTexture: toolbar.showMagneticTexture,
      showAirbox: toolbar.showAirbox,
      showQuantity: toolbar.showQuantity,
      showVectors: toolbar.showVectors,
    },
    interaction: {
      mode: "pan_zoom",
      probePoint: null,
      profileLine: null,
    },
    render: {
      query: frame.query,
      resourceKind: frame.resourceKind,
      meta: null,
      sampling: frame.sampling,
    },
    revisions,
    capabilities,
    capabilityGates: gates,
    diagnostics: {
      status: !capabilities.preview_2d ? "degraded" : stale ? "stale" : "ready",
      messages: frame.diagnostics,
      staleProfile: stale,
      staleProbe: stale,
    },
  };
}

export function createFdmSlice2DAdapter(
  capabilities: Slice2DCapabilities,
): Slice2DAdapter {
  return {
    kind: "fdm",
    buildSlice(request) {
      if (!capabilities.preview_2d) {
        return unavailableFrame("Requires preview_2d capability");
      }
      if (!capabilities.structured_grid) {
        return unavailableFrame("Requires structured_grid capability");
      }
      return {
        query: field2DQueryFromRequest(request),
        resourceKind: request.plane.mode === "all_layers" ? "projection" : "slice",
        sampling: request.plane.mode === "all_layers" ? "fdm-projection" : "fdm-layer",
        diagnostics:
          request.plane.mode === "all_layers" && !capabilities.slice_all_layers
            ? ["All layers mode is disabled for this runtime"]
            : [],
      };
    },
  };
}

export function createFemSlice2DAdapter(
  capabilities: Slice2DCapabilities,
): Slice2DAdapter {
  return {
    kind: "fem",
    buildSlice(request) {
      if (!capabilities.preview_2d) {
        return unavailableFrame("Requires preview_2d capability");
      }
      if (!capabilities.explicit_topology) {
        return unavailableFrame("Requires explicit_topology capability");
      }
      const query = fieldSliceQueryFromRequest(request);
      const allLayers = request.plane.mode === "all_layers";
      return {
        query: allLayers
          ? fieldProjectionQueryFromRequest(request)
          : {
            ...query,
            include_arrows: request.toolbar.showVectors && capabilities.slice_vectors,
          },
        resourceKind: allLayers ? "projection" : "slice",
        sampling: allLayers ? "fem-projection" : "fem-plane",
        diagnostics:
          request.plane.mode === "slab"
            ? ["Slab mode samples a band around the FEM cut plane"]
            : [],
      };
    },
  };
}

export function fieldSliceQueryFromRequest(request: SliceBuildRequest): FieldSliceQuery {
  const cut =
    typeof request.toolbar.positionWorld === "number"
      ? { cut_world: request.toolbar.positionWorld }
      : { cut_norm: request.plane.positionPercent / 100 };
  const resolution = request.toolbar.projectionResolution;
  return {
    plane: planeTokenFromAxis(request.plane.axis),
    component: request.toolbar.component ?? fieldComponentFromQuantity(request.quantity),
    ...cut,
    x_size: resolution,
    y_size: resolution,
    max_points: request.toolbar.mode === "all_layers" ? undefined : 100_000,
    include_arrows: request.toolbar.showVectors,
    arrow_every: request.toolbar.showVectors ? 4 : undefined,
    max_arrows: request.toolbar.showVectors ? 10_000 : undefined,
  };
}

export function fieldProjectionQueryFromRequest(request: SliceBuildRequest): FieldProjectionQuery {
  const resolution = request.toolbar.projectionResolution;
  return {
    plane: planeTokenFromAxis(request.plane.axis),
    component: request.toolbar.component ?? fieldComponentFromQuantity(request.quantity),
    reduction: request.toolbar.projectionReduction,
    include_air_as_zero: request.toolbar.projectionIncludeAirAsZero,
    samples: request.toolbar.projectionSamples,
    x_size: resolution,
    y_size: resolution,
    max_points: Math.max(1, resolution * resolution),
  };
}

export function field2DQueryFromRequest(
  request: SliceBuildRequest,
): FieldSliceQuery | FieldProjectionQuery {
  return request.plane.mode === "all_layers"
    ? fieldProjectionQueryFromRequest(request)
    : fieldSliceQueryFromRequest(request);
}

function planeTokenFromAxis(axis: SliceAxis): FieldSliceQuery["plane"] {
  if (axis === "x") {
    return "yz";
  }
  if (axis === "y") {
    return "xz";
  }
  return "xy";
}

function fieldComponentFromQuantity(quantity: QuantitySelectionState): FieldComponent {
  return quantity.component === "3D" ? "magnitude" : quantity.component;
}

function unavailableFrame(message: string): SliceFrame {
  return {
    query: null,
    resourceKind: null,
    sampling: "unavailable",
    diagnostics: [message],
  };
}

export const __slice2DAdapterInternals = {
  planeTokenFromAxis,
  fieldComponentFromQuantity,
  fieldSliceQueryFromRequest,
  fieldProjectionQueryFromRequest,
  field2DQueryFromRequest,
};
