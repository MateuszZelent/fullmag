"use client";

import type { LiveStatusResource } from "../api/apiTypes";

import { useSessionStatusSelector } from "./useSessionStatus";

export type ActiveLaneCapabilitySnapshot =
  LiveStatusResource["capabilities"]["active_lane"];

export type ActiveLaneOperationId =
  | "grid_build"
  | "shared_mesh_build"
  | "field_quantity"
  | "vectors"
  | "surface_coloring"
  | "air_void_overlay"
  | "region_membership"
  | "hover_select_cell"
  | "initial_magnetization.uniform"
  | "initial_magnetization.vortex"
  | "interaction.exchange"
  | "interaction.demag"
  | "interaction.dmi"
  | "interaction.zeeman"
  | "interaction.current_transport"
  | "interaction.spin_torque"
  | "interaction.sot"
  | "interaction.stt"
  | "interaction.interfacial_dmi"
  | "interaction.bulk_dmi"
  | "interaction.uniaxial_anisotropy"
  | "interaction.cubic_anisotropy"
  | "interaction.oersted"
  | "interaction.oersted_field"
  | "interaction.magnetoelastic"
  | "interaction.thermal"
  | "interaction.frozen_spins"
  | "constraint.frozen_spins"
  | "study.relaxation"
  | "study.time_integration"
  | "study.eigenmodes"
  | "study.frequency_response"
  | "study.fft";

type ActiveLaneOperation =
  ActiveLaneCapabilitySnapshot["operations"][string];

export interface ActiveLaneOperationResolution extends ActiveLaneOperation {
  enabled: boolean;
}

const STALE_OPERATION: ActiveLaneOperationResolution = {
  enabled: false,
  state: "stale",
  reason_code: "capability_stale",
  reason: "Active-lane capability snapshot is unavailable.",
  requires: ["planner_capability_snapshot"],
};

export type ActiveLaneOperationPresentationState =
  | "supported"
  | "semantic_only"
  | "deferred"
  | "not-applicable"
  | "not-materialized";

export type ActiveLaneOperationPresentation = Omit<ActiveLaneOperation, "state"> & {
  state: ActiveLaneOperationPresentationState;
};

export function resolveActiveLaneOperationPresentation(
  operation: ActiveLaneOperation,
): ActiveLaneOperationPresentation {
  if (operation.state === "unsupported") {
    return { ...operation, state: "not-applicable" };
  }
  if (operation.state === "stale") {
    return { ...operation, state: "not-materialized" };
  }
  if (
    operation.state === "supported" ||
    operation.state === "semantic_only" ||
    operation.state === "deferred"
  ) {
    return { ...operation, state: operation.state };
  }
  const unreachable: never = operation.state;
  throw new Error(`Unknown active-lane capability state: ${unreachable}`);
}

export function resolveActiveLaneOperation(
  snapshot: ActiveLaneCapabilitySnapshot | null,
  operationId: ActiveLaneOperationId,
): ActiveLaneOperationResolution {
  const operation = snapshot?.operations[operationId];
  if (!operation) {
    return STALE_OPERATION;
  }
  return {
    ...operation,
    enabled: operation.state === "supported",
  };
}

export function selectActiveLaneCapabilitySnapshot(
  status: { data: Pick<LiveStatusResource, "capabilities"> | null },
): ActiveLaneCapabilitySnapshot | null {
  return status.data?.capabilities.active_lane ?? null;
}

export function useActiveLaneCapabilities({
  enabled = true,
}: {
  enabled?: boolean;
} = {}): ActiveLaneCapabilitySnapshot | null {
  return useSessionStatusSelector(selectActiveLaneCapabilitySnapshot, { enabled });
}
