import type { RuntimeCommandPrecondition } from "@/kernel/api/apiTypes";
import type { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import type { CommandContext } from "@/kernel/commands/commandTypes";

export type MeshBuildConfirmCommandId =
  | "mesh.build-selected"
  | "mesh.build-shared-domain"
  | "mesh.refine-worst-quality-element";

const MESH_BUILD_CONFIRM_COMMAND_IDS = new Set<string>([
  "mesh.build-selected",
  "mesh.build-shared-domain",
  "mesh.refine-worst-quality-element",
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

type MeshDraftGuard = () => Promise<boolean>;
const draftGuards = new WeakMap<EventBus<KernelEventMap>, MeshDraftGuard>();

/** Registers the mounted Inspector owner without moving its draft into the kernel. */
export function registerMeshBuildDraftGuard(bus: EventBus<KernelEventMap>, guard: MeshDraftGuard): () => void {
  draftGuards.set(bus, guard);
  return () => { if (draftGuards.get(bus) === guard) draftGuards.delete(bus); };
}

let confirmationSequence = 0;

/** Every mesh command waits for the same preflight, regardless of its UI source. */
export async function awaitMeshBuildConfirmation(
  context: CommandContext,
  commandId: MeshBuildConfirmCommandId,
  input?: unknown,
): Promise<{ confirmed: boolean; requestId: string; precondition?: RuntimeCommandPrecondition }> {
  const requestId = `mesh-confirm-${Date.now()}-${++confirmationSequence}`;
  const bus = context.bus;
  if (!bus) return { confirmed: false, requestId };
  const guard = draftGuards.get(bus);
  if (guard && !(await guard())) return { confirmed: false, requestId };
  return new Promise((resolve) => {
    const off = bus.on("mesh:build-confirm-resolved", (result) => {
      if (result.requestId !== requestId) return;
      off();
      resolve({ confirmed: result.confirmed, requestId, ...(result.precondition ? { precondition: result.precondition } : {}) });
    });
    requestMeshBuildConfirmation(bus, {
      commandId,
      input: input === undefined ? undefined : structuredClone(input),
      requestId,
      source: context.source,
      sourceDetail: context.sourceDetail,
    });
  });
}