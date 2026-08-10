import type {
  PlanarFieldProbeQuery,
  PlanarFieldQuery,
} from "@/kernel/api/apiTypes";

export type FieldMapViewScopeKind = "monitor_target" | "mesh_part" | "airbox";

/** The planar profile is the source of truth for scope identity. */
export interface FieldMapViewScope {
  kind: FieldMapViewScopeKind;
  scope_id?: string | null;
}

export type FieldMapDataPlanAvailability =
  | "inactive"
  | "not-applicable"
  | "ready";

export interface FieldMapDataPlanInput {
  active: boolean;
  component: string;
  discretization?: string | null;
  expectedFieldRevision?: number | null;
  expectedMeshRevision?: number | null;
  expectedMonitorRevision?: number | null;
  includeMesh: boolean;
  monitorId: string | null;
  quantityId: string;
  resolution: readonly [number, number];
  showVectors: boolean;
  snapshotId?: string | null;
  stageId?: string | null;
  viewScope?: FieldMapViewScope | null;
}

export interface FieldMapDataPlan {
  availability: FieldMapDataPlanAvailability;
  enabled: boolean;
  monitorId: string;
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
  const fdm = input.discretization?.trim().toLowerCase() === "fdm";
  const fdmUnsupportedScope =
    fdm && (viewScope.kind === "mesh_part" || viewScope.kind === "airbox");
  const unavailableReason = fdmUnsupportedScope
    ? "structured FDM grid planar sampling does not support mesh-part or airbox scopes."
    : null;
  const enabled =
    input.active && input.monitorId !== null && !fdmUnsupportedScope;
  const availability: FieldMapDataPlanAvailability = fdmUnsupportedScope
    ? "not-applicable"
    : enabled
      ? "ready"
      : "inactive";
  return {
    availability,
    enabled,
    monitorId: input.monitorId ?? "",
    quantityId: input.quantityId,
    query: {
      component: input.component,
      expected_field_revision: input.expectedFieldRevision ?? undefined,
      expected_mesh_revision: input.expectedMeshRevision ?? undefined,
      expected_monitor_revision: input.expectedMonitorRevision ?? undefined,
      include_mesh: input.includeMesh,
      quality: "interactive",
      resolution_x: input.resolution[0],
      resolution_y: input.resolution[1],
      // The v2 contract only accepts an id for mesh_part. In particular,
      // monitor_target and airbox must not receive a guessed id.
      scope_id:
        viewScope.kind === "mesh_part" ? viewScope.scope_id ?? undefined : undefined,
      scope_kind: viewScope.kind,
      snapshot_id: input.snapshotId ?? undefined,
      stage_id: input.stageId ?? undefined,
      vector_budget: input.showVectors ? 2_000 : 0,
    },
    requestMask: enabled,
    requestMesh: enabled && input.includeMesh,
    requestScalar: enabled,
    requestVectors: enabled && input.showVectors,
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
