import { UNKNOWN_MESH_COMMAND_LANE_REASON, resolveMeshCommandLane, type MeshCommandLane } from "@/kernel/authoring/geometryLifecycleCommandContributions";

export function resolveMeshBuildDialogLane(
  discretization: unknown,
): MeshCommandLane {
  return resolveMeshCommandLane(discretization);
}

export function shouldLoadMeshBuildDialogFemResources(
  open: boolean,
  lane: MeshCommandLane,
): boolean {
  return open && lane === "fem";
}

export function meshBuildDialogUnavailableMessage(
  lane: MeshCommandLane,
  fdmGridRefreshReason?: string,
): string | null {
  if (lane === "fdm") {
    return (
      fdmGridRefreshReason ??
      "FDM grid and membership masks are rebuilt by an atomic execution-plan replan. Use Mesh → Build Grid."
    );
  }
  if (lane === "unknown") return UNKNOWN_MESH_COMMAND_LANE_REASON;
  return null;
}

export function fdmGridPreflightState(
  requestedRevision: number | null,
  sceneRevision: number | null,
  statusRevision: number | null | undefined,
): "pending" | "current" | "stale" {
  if (requestedRevision === null) return "pending";
  if ((sceneRevision ?? -1) > requestedRevision || (statusRevision ?? -1) > requestedRevision) {
    return "stale";
  }
  return sceneRevision === requestedRevision && statusRevision === requestedRevision
    ? "current"
    : "pending";
}
