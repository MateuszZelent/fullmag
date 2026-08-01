import type { PlanarFieldQuery } from "@/kernel/api/apiTypes";

export interface FieldMapDataPlanInput {
  active: boolean;
  component: string;
  includeMesh: boolean;
  monitorId: string | null;
  quantityId: string;
  resolution: readonly [number, number];
  showVectors: boolean;
}

export interface FieldMapDataPlan {
  enabled: boolean;
  monitorId: string;
  quantityId: string;
  query: PlanarFieldQuery;
  requestMask: boolean;
  requestMesh: boolean;
  requestScalar: boolean;
  requestVectors: boolean;
}

export function buildFieldMapDataPlan(
  input: FieldMapDataPlanInput,
): FieldMapDataPlan {
  const enabled = input.active && input.monitorId !== null;
  return {
    enabled,
    monitorId: input.monitorId ?? "",
    quantityId: input.quantityId,
    query: {
      component: input.component,
      include_mesh: input.includeMesh,
      quality: "interactive",
      resolution_x: input.resolution[0],
      resolution_y: input.resolution[1],
      vector_budget: input.showVectors ? 2_000 : 0,
    },
    requestMask: enabled,
    requestMesh: enabled && input.includeMesh,
    requestScalar: enabled,
    requestVectors: enabled && input.showVectors,
  };
}
