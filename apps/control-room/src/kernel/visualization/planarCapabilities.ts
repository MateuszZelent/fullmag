import { quantityCatalogEntrySupportsSpatialVisualization, type QuantityCatalogEntry } from "../api/quantityIds";
import {
  isFlowMajorTensorDescriptor,
  tensorProjectionOutputKind,
  type TensorFieldDescriptor,
} from "../api/tensorFieldProjection";

export interface FieldMapCapability {
  enabled: boolean;
  reasonCode: string | null;
}

export interface PlanarMeshOverlayDescriptor {
  available: boolean;
  boundaryClassification: string;
  codec: string | null | undefined;
  geometrySource?: string | null;
}

export interface PlanarInspectorCapabilities {
  boundaries: FieldMapCapability;
  bounds: FieldMapCapability;
  contours: FieldMapCapability;
  mesh: FieldMapCapability;
  points: FieldMapCapability;
  raster: FieldMapCapability;
  vectors: FieldMapCapability;
}

export type PlanarScopeKind = "monitor_target" | "mesh_part" | "airbox" | "layer" | "region";

/**
 * Structured FDM grids have no mesh parts; native layers exist only for FDM
 * multilayer carriers. The Airbox scope is requested so the backend can
 * resolve its carrier (FDM Airbox cells or FEM airbox elements); it fails
 * there with its exact reason. Presented capabilities wait for that result
 * (`resolvePlanarInspectorCapabilities`).
 */
export function planarScopeCapability(input: {
  discretization: string | null | undefined;
  scopeKind: PlanarScopeKind;
}): FieldMapCapability {
  const discretization = input.discretization?.trim().toLowerCase();
  if (discretization === "fdm" && input.scopeKind === "mesh_part") {
    return { enabled: false, reasonCode: "fdm_scope_not_supported" };
  }
  if (discretization === "fem" && input.scopeKind === "layer") {
    return { enabled: false, reasonCode: "fem_layer_scope_not_supported" };
  }
  return { enabled: true, reasonCode: null };
}

export function resolveFieldMapCapabilities(input: {
  meshOverlayAvailable: boolean;
  spatial: boolean;
  vectorComponents: number;
}) {
  const unsupported = (reasonCode: string): FieldMapCapability => ({
    enabled: false,
    reasonCode,
  });
  const supportedShape = input.vectorComponents === 1 ||
    input.vectorComponents === 2 || input.vectorComponents === 3;
  return {
    contours: input.spatial && supportedShape
      ? { enabled: true, reasonCode: null }
      : unsupported(input.spatial ? "quantity_shape_unsupported" : "quantity_not_spatial"),
    mesh: input.meshOverlayAvailable
      ? { enabled: true, reasonCode: null }
      : unsupported("mesh_overlay_unavailable"),
    vectors:
      input.spatial && (input.vectorComponents === 2 || input.vectorComponents === 3)
        ? { enabled: true, reasonCode: null }
        : unsupported(
            !input.spatial ? "quantity_not_spatial"
              : supportedShape ? "quantity_not_vector" : "quantity_shape_unsupported",
          ),
  };
}

/** Keeps Field Map and the Inspector on one fail-closed capability vocabulary. */
export function resolvePlanarInspectorCapabilities(input: {
  descriptor: PlanarMeshOverlayDescriptor | null | undefined;
  discretization: string | null | undefined;
  metaAvailable?: boolean;
  /** Exact backend reason when the planar metadata request failed. */
  metaErrorCode?: string | null;
  occupancyAvailable?: boolean;
  component?: string | null;
  tensor?: TensorFieldDescriptor | null;
  catalogQuantity?: QuantityCatalogEntry | null;
  quantity: {
    available: boolean;
    components: number;
    location?: string | null;
  } | null | undefined;
  scopeKind: PlanarScopeKind;
}): PlanarInspectorCapabilities {
  const quantityAvailable = input.quantity?.available === true;
  const spatial =
    quantityAvailable &&
    input.quantity?.location?.trim().toLowerCase() !== "global";
  const metaAvailable = input.metaAvailable ?? false;
  const requestedScope = planarScopeCapability({
    discretization: input.discretization,
    scopeKind: input.scopeKind,
  });
  // P1-04: the backend resolves the Airbox carrier (FDM Airbox cells or FEM
  // airbox elements) per quantity. Its sample metadata is the single
  // capability source, so nothing is shown as supported before it resolves.
  const scope: FieldMapCapability = requestedScope.enabled &&
    input.scopeKind === "airbox" &&
    !metaAvailable
    ? { enabled: false, reasonCode: input.metaErrorCode ?? "airbox_carrier_unresolved" }
    : requestedScope;
  const descriptor = input.descriptor;
  const meshOverlayAvailable =
    spatial &&
    scope.enabled &&
    descriptor?.available === true &&
    (descriptor.codec === "fmcs.v4" ||
      (descriptor.codec === "fmfg.v1" && descriptor.geometrySource === "fdm_structured_grid"));
  let vectorComponents = input.quantity?.components ?? 0;
  const tensorProjection = tensorProjectionOutputKind(input.component);
  if (input.tensor != null || vectorComponents === 9 || tensorProjection !== null) {
    vectorComponents = isFlowMajorTensorDescriptor(input.tensor) &&
      vectorComponents === 9 && tensorProjection !== null &&
      input.catalogQuantity != null &&
      quantityCatalogEntrySupportsSpatialVisualization(input.catalogQuantity, input.component)
      ? tensorProjection === "vector" ? 3 : 1
      : 0;
  }
  const base = resolveFieldMapCapabilities({
    meshOverlayAvailable,
    spatial: spatial && scope.enabled,
    vectorComponents,
  });
  const bounds = spatial && scope.enabled && metaAvailable
    ? { enabled: true, reasonCode: null }
    : {
        enabled: false,
        reasonCode: !scope.enabled
          ? scope.reasonCode
          : !spatial
            ? "quantity_not_spatial"
            : "planar_meta_unavailable",
      };
  const points = spatial && scope.enabled && metaAvailable && input.occupancyAvailable === true
    ? { enabled: true, reasonCode: null }
    : {
        enabled: false,
        reasonCode: !scope.enabled
          ? scope.reasonCode
          : !spatial
            ? "quantity_not_spatial"
            : !metaAvailable
              ? "planar_meta_unavailable"
              : "occupancy_mask_unavailable",
      };
  const boundaries =
    meshOverlayAvailable && descriptor?.boundaryClassification === "exact"
      ? { enabled: true, reasonCode: null }
      : {
          enabled: false,
          reasonCode: !scope.enabled
            ? scope.reasonCode
            : !spatial
              ? "quantity_not_spatial"
              : !descriptor?.available
                ? "mesh_overlay_unavailable"
                : descriptor.codec === "fmfg.v1"
                  ? "target_boundaries_unavailable"
                  : descriptor.codec !== "fmcs.v4"
                    ? "mesh_overlay_codec_unsupported"
                    : "boundaries_not_exact",
        };

  // A disabled scope is the exact reason for every carrier-dependent layer.
  const scoped = (capability: FieldMapCapability): FieldMapCapability =>
    scope.enabled ? capability : { enabled: false, reasonCode: scope.reasonCode };
  return {
    boundaries,
    bounds,
    contours: scoped(base.contours),
    mesh: scoped(base.mesh),
    points,
    raster: scoped(base.contours),
    vectors: scoped(base.vectors),
  };
}
