import type { KernelApi } from "../types";
import type { MeshBuildHistoryEntry } from "@/shared/domain/mesh/meshBuildHistory";

export function meshHistoryRestoreTarget(entry: MeshBuildHistoryEntry): string | null {
  const snapshot = entry.canonicalPolicySnapshot;
  if (!snapshot) return null;
  const objectId = entry.meshTarget?.match(/^object_mesh:(.+)$/)?.[1];
  if (objectId && snapshot.objects && typeof snapshot.objects === "object"
    && Object.hasOwn(snapshot.objects, objectId)) return `object:${objectId}`;
  if (entry.meshTarget && /^(study_domain|shared_domain|universe|airbox)$/.test(entry.meshTarget)
    && Object.hasOwn(snapshot, "universe")) return "universe";
  return null;
}

/** Deliver once after the selected editor mounts and loads its canonical base. */
export function restoreMeshHistoryToDraft(
  kernel: Pick<KernelApi, "bus" | "selection">,
  entry: MeshBuildHistoryEntry,
): void {
  const target = meshHistoryRestoreTarget(entry);
  if (!target || !entry.canonicalPolicySnapshot) return;
  const objectId = target === "universe" ? null : target.slice("object:".length);
  const nodeId = objectId ? `model:object:${objectId}:mesh` : "model:airbox:mesh:parameters";
  const payload = {
    buildId: entry.buildId ?? undefined,
    commandId: entry.commandId ?? undefined,
    entryId: entry.id,
    meshTarget: entry.meshTarget,
    snapshot: structuredClone(entry.canonicalPolicySnapshot),
  };
  let offSelection = () => {};
  const offReady = kernel.bus.on("mesh:build-history-editor-ready", (event) => {
    if (event.target !== target || kernel.selection.get().nodeId !== nodeId) return;
    offReady();
    offSelection();
    kernel.bus.emit("mesh:build-history-restore-requested", payload);
  });
  offSelection = kernel.selection.subscribe((selection) => {
    if (selection.nodeId === nodeId) return;
    offReady();
    offSelection();
  });
  kernel.selection.set(objectId ? {
    kind: "object.mesh", nodeId, objectId, label: objectId,
    ref: { kind: "object.mesh", nodeId, objectId, type: "scene-object", visualizationTargetId: `object:${objectId}` },
  } : {
    kind: "airbox.mesh.parameters", nodeId, objectId: null, label: "Airbox Parameters",
    ref: { kind: "airbox.mesh.parameters", nodeId, type: "airbox", visualizationTargetId: "airbox" },
  }, "mesh");
  if (kernel.selection.get().nodeId !== nodeId) {
    offReady();
    offSelection();
  }
}
