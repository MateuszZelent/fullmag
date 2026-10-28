import { tensorProjectionOutputKind } from "@/kernel/api/tensorFieldProjection";
import type {
  PlanarFieldProbeQuery,
  PlanarFieldQuery,
  PlanarFieldSource,
} from "@/kernel/api/apiTypes";

import { planarScopeCapability } from "./fieldMapCapabilities";

export type FieldMapViewScopeKind = "monitor_target" | "mesh_part" | "airbox" | "layer" | "region";

/** The planar profile is the source of truth for scope identity. */
export interface FieldMapViewScope {
  kind: FieldMapViewScopeKind;
  scope_id?: string | null;
  /** Region within the `scope_id` object for `region` scopes. */
  region_id?: string | null;
}

/**
 * Query parameters of a planar view scope. The v2 contract accepts an id only
 * for mesh_part, layer and region (object id plus `scope_region_id`);
 * monitor_target and airbox must not receive a guessed id.
 */
export function planarScopeQuery(
  viewScope: FieldMapViewScope,
): Pick<PlanarFieldQuery, "scope_id" | "scope_kind" | "scope_region_id"> {
  const scopeId = viewScope.kind === "mesh_part" ||
    viewScope.kind === "layer" ||
    viewScope.kind === "region"
    ? viewScope.scope_id ?? undefined
    : undefined;
  return {
    scope_id: scopeId,
    scope_kind: viewScope.kind,
    scope_region_id: viewScope.kind === "region" ? viewScope.region_id ?? undefined : undefined,
  };
}

export type FieldMapDataPlanAvailability =
  | "inactive"
  | "not-applicable"
  | "ready";

export interface FieldMapDataPlanInput {
  active: boolean;
  component: string;
  discretization?: string | null;
  includeMesh: boolean;
  source: PlanarFieldSource;
  quality: "interactive" | "export";
  quantityId: string;
  projectionAllowed?: boolean;
  resolution: readonly [number, number];
  showVectors: boolean;
  /** The raster is coloured by vector direction, which needs the vector payload. */
  colorByDirection?: boolean;
  snapshotId?: string | null;
  stageId?: string | null;
  vectorBudget: number;
  viewScope?: FieldMapViewScope | null;
}

export interface FieldMapDataPlan {
  availability: FieldMapDataPlanAvailability;
  enabled: boolean;
  source: PlanarFieldSource;
  quantityId: string;
  query: PlanarFieldQuery;
  requestMask: boolean;
  requestMesh: boolean;
  requestScalar: boolean;
  requestVectors: boolean;
  unavailableReason: string | null;
}

export function buildFieldMapDataPlan(
  input: FieldMapDataPlanInput,
): FieldMapDataPlan {
  const viewScope = input.viewScope ?? { kind: "monitor_target" as const };
  const scope = planarScopeCapability({
    discretization: input.discretization,
    scopeKind: viewScope.kind,
  });
  const projectionAllowed = input.projectionAllowed !== false;
  const unavailableReason = !scope.enabled
    ? scope.reasonCode === "fem_layer_scope_not_supported"
      ? "native layer scope requires an FDM multilayer carrier."
      : "structured FDM grid planar sampling does not support mesh-part scope."
    : !projectionAllowed ? "The selected tensor projection is not available in the canonical catalog." : null;
  const enabled = input.active && scope.enabled && projectionAllowed;
  const needsVectors = tensorProjectionOutputKind(input.component) !== "scalar" &&
    (input.showVectors || input.colorByDirection === true);
  const availability: FieldMapDataPlanAvailability = !scope.enabled || !projectionAllowed
    ? "not-applicable"
    : enabled
      ? "ready"
      : "inactive";
  return {
    availability,
    enabled,
    source: input.source,
    quantityId: input.quantityId,
    query: {
      component: input.component,
      include_mesh: input.includeMesh,
      quality: input.quality,
      resolution_x: input.resolution[0],
      resolution_y: input.resolution[1],
      ...planarScopeQuery(viewScope),
      snapshot_id: input.snapshotId ?? undefined,
      stage_id: input.stageId ?? undefined,
      vector_budget: needsVectors ? input.vectorBudget : 0,
    },
    requestMask: enabled,
    requestMesh: enabled && input.includeMesh,
    requestScalar: enabled,
    requestVectors: enabled && needsVectors,
    unavailableReason,
  };
}

/** Add probe coordinates without dropping the raster's scope/provenance identity. */
export function buildFieldMapProbeQuery(
  query: PlanarFieldQuery,
  uM: number,
  vM: number,
): PlanarFieldProbeQuery {
  return { ...query, u_m: uM, v_m: vM } as PlanarFieldProbeQuery;
}
