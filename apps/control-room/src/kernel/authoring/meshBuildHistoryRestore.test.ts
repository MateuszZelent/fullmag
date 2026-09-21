import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { SelectionController } from "../selection/SelectionController";
import { normalizeMeshBuildHistory } from "@/shared/domain/mesh/meshBuildHistory";
import { meshHistoryRestoreTarget, restoreMeshHistoryToDraft } from "./meshBuildHistoryRestore";

function setup(meshTarget = "object_mesh:film") {
  const bus = new EventBus<KernelEventMap>();
  const selection = new SelectionController(bus);
  selection.set({ kind: "mesh.builds", nodeId: "model:mesh:builds" }, "mesh");
  const [entry] = normalizeMeshBuildHistory([{
    build_id: "build-a", mesh_target: meshTarget,
    canonical_policy_snapshot: { objects: { film: { maximum_element_size: 1e-8 } }, universe: null },
  }]);
  return { kernel: { bus, selection }, entry };
}

describe("mesh history restore navigation", () => {
  it.each(["object_mesh:film", "study_domain", "airbox"])("waits for the mounted %s editor and delivers only once", (target) => {
    const { kernel, entry } = setup(target);
    restoreMeshHistoryToDraft(kernel, entry);
    const isObject = target.startsWith("object_mesh");
    expect(kernel.selection.get().nodeId).toBe(isObject ? "model:object:film:mesh" : "model:airbox:mesh:parameters");
    // The destination installs its listener after navigation, as it does on React mount.
    const receive = vi.fn();
    kernel.bus.on("mesh:build-history-restore-requested", receive);
    kernel.bus.emit("mesh:build-history-editor-ready", { target: "object:other" });
    expect(receive).not.toHaveBeenCalled();
    kernel.bus.emit("mesh:build-history-editor-ready", { target: isObject ? "object:film" : "universe" });
    expect(receive).toHaveBeenCalledWith(expect.objectContaining({ entryId: "build-a", snapshot: entry.canonicalPolicySnapshot }));
    kernel.bus.emit("mesh:build-history-editor-ready", { target: isObject ? "object:film" : "universe" });
    expect(receive).toHaveBeenCalledOnce();
  });

  it("cancels when the user leaves before the editor loads", () => {
    const { kernel, entry } = setup();
    const receive = vi.fn();
    kernel.bus.on("mesh:build-history-restore-requested", receive);
    restoreMeshHistoryToDraft(kernel, entry);
    kernel.selection.clear("mesh");
    kernel.bus.emit("mesh:build-history-editor-ready", { target: "object:film" });
    expect(receive).not.toHaveBeenCalled();
  });

  it("does not retain a restore rejected by the selection guard", () => {
    const { kernel, entry } = setup();
    const removeGuard = kernel.selection.addChangeGuard(() => false);
    const receive = vi.fn();
    kernel.bus.on("mesh:build-history-restore-requested", receive);
    restoreMeshHistoryToDraft(kernel, entry);
    removeGuard();
    kernel.selection.set({ kind: "object.mesh", nodeId: "model:object:film:mesh" }, "mesh");
    kernel.bus.emit("mesh:build-history-editor-ready", { target: "object:film" });
    expect(receive).not.toHaveBeenCalled();
  });

  it("does not reinterpret shared-domain solver settings as Airbox policy", () => {
    const { entry } = setup("study_domain");
    entry.canonicalPolicySnapshot = { shared_domain: { hmax: 1e-8 } };
    expect(meshHistoryRestoreTarget(entry)).toBeNull();
  });
});
