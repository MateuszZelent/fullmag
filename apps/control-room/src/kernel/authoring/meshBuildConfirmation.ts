import type { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";

export type MeshBuildConfirmCommandId =
  | "mesh.build-selected"
  | "mesh.build-shared-domain";

const MESH_BUILD_CONFIRM_COMMAND_IDS = new Set<string>([
  "mesh.build-selected",
  "mesh.build-shared-domain",
]);

export function isMeshBuildConfirmCommandId(
  commandId: string,
): commandId is MeshBuildConfirmCommandId {
  return MESH_BUILD_CONFIRM_COMMAND_IDS.has(commandId);
}

export function requestMeshBuildConfirmation(
  bus: EventBus<KernelEventMap>,
  request: KernelEventMap["mesh:build-confirm-requested"],
): void {
  bus.emit("mesh:build-confirm-requested", request);
}
