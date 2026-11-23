import { describe, expect, it, vi } from "vitest";
import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { SceneResource } from "@/kernel/api/apiTypes";
import { ObjectEditSessionController } from "@/kernel/authoring/object-edit/ObjectEditSessionController";
import { PendingFormRegistry } from "@/kernel/authoring/PendingFormRegistry";
import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import type { CommandContext } from "@/kernel/commands/commandTypes";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { SelectionController } from "@/kernel/selection/SelectionController";
import { visualizationTargetIdForSceneObject } from "@/kernel/selection/selectionTypes";
import { RIBBON_COMMANDS } from "./ribbonCommands";
import { ObjectVisualizationController } from "@/kernel/visualization/ObjectVisualizationController";
import { buildRibbonTabContent } from "./ribbonContributions";

const id = "physics.add-absorbing-boundary";
const defaults = {
  faces: ["x+"], frame: "object", max_damping: 0.5, profile: "smootherstep",
  ramp_width_m: 3e-7, total_width_m: 4e-7,
} as const;

function setup(scene: SceneResource = { revision: 7, objects: [{ id: "body", role: "magnet" }] }) {
  const bus = new EventBus<KernelEventMap>();
  const selection = new SelectionController(bus);
  const pendingForms = new PendingFormRegistry();
  const resources = new ResourceInvalidationController(bus);
  const registry = new CommandRegistry();
  for (const command of RIBBON_COMMANDS) registry.register(command);
  function selectRoot(objectId: string) {
    const nodeId = "model:object:" + objectId;
    selection.set({ kind: "object.root", label: "Same name", nodeId, objectId,
      ref: { kind: "object.root", nodeId, objectId, type: "scene-object",
        visualizationTargetId: visualizationTargetIdForSceneObject(objectId) } }, "viewport-3d");
  }
  selectRoot("body");
  const ack: SceneResource = { revision: 8, objects: [
    { id: "body", role: "magnet", absorbing_boundary: { ...defaults, faces: ["x+"] } },
  ] };
  const patchObject = vi.fn(async () => ack);
  const showPanel = vi.fn();
  const isCurrentSessionScope = vi.fn(() => true);
  const context: CommandContext = {
    api: { model: { patchObject }, resourceCacheScope: "abl-test" } as unknown as CommandContext["api"],
    isCurrentSessionScope, layout: { setPanelVisible: showPanel } as unknown as CommandContext["layout"],
    objectEditSession: new ObjectEditSessionController(), pendingForms,
    resourceData: { [MODEL_SCENE_PATH]: scene }, resources, selection, sessionScopeKey: "session-one", source: "ribbon",
  };
  return { ack, context, isCurrentSessionScope, patchObject, pendingForms, registry, resources, selectRoot,
    selection, showPanel, execute: () => registry.execute(id, context), enabled: () => registry.isEnabled(id, context) };
}

describe("Physics ribbon absorbing boundary", () => {
  it("adds the initial boundary to the selected viewport object and opens its editor", async () => {
    const test = setup();
    const visualization = new ObjectVisualizationController();
    const action = buildRibbonTabContent("physics", {
      commandContext: test.context,
      commands: test.registry,
      selection: test.selection.get(),
      visualization,
      visualizationSnapshot: visualization.getSnapshot(),
    })?.groups.flatMap(group => group.actions).find(action => action.commandId === id);
    expect(action).toMatchObject({ label: "Add ABL", disabled: false });
    expect(test.enabled()).toBe(true);
    expect(await test.execute()).toMatchObject({ status: "completed" });
    expect(test.patchObject).toHaveBeenCalledWith("body", {
      absorbing_boundary: defaults, base_revision: 7,
    }, { baseRevision: 7, sessionScopeKey: "session-one" });
    expect(test.resources.getRevision(MODEL_SCENE_PATH)).toBe(8);
    expect(test.selection.get()).toMatchObject({ kind: "object.absorbing-boundary", objectId: "body",
      nodeId: "model:object:body:absorbing-boundary" });
    expect(test.showPanel).toHaveBeenCalledWith("right", true);
  });

  it("opens a saved layer collection without resetting it", async () => {
    const test = setup({ revision: 9, objects: [{ id: "body", role: "magnet", absorbing_boundary: { layers: [
      { layer_id: "saved", name: "Custom exit", enabled: true, geometry: { kind: "faces", faces: ["z-"] },
        total_width_m: 1e-6, ramp_width_m: 7e-7, max_damping: 0.77, profile: "linear", frame: "universe" },
    ] } }] });
    expect(await test.execute()).toMatchObject({ status: "completed" });
    expect(test.patchObject).not.toHaveBeenCalled();
    expect(test.selection.get().kind).toBe("object.absorbing-boundary");
  });

  it.each(["antenna", "auxiliary", null])("rejects canonical role %s regardless of its name", async role => {
    const test = setup({ revision: 7, objects: [{ id: "body", name: "Magnet", role }] });
    expect(test.enabled()).toBe(false);
    expect(await test.execute()).toMatchObject({ status: "failed" });
    expect(test.patchObject).not.toHaveBeenCalled();
  });

  it("requires a revision and an unlocked object to create the boundary", () => {
    expect(setup({ objects: [{ id: "body", role: "magnet" }] }).enabled()).toBe(false);
    expect(setup({ revision: 7, objects: [{ id: "body", role: "magnet", locked: true }] }).enabled()).toBe(false);
  });

  it("blocks missing objects, empty selections and pending Inspector changes", () => {
    const test = setup();
    test.selection.clear("explorer");
    expect(test.enabled()).toBe(false);
    test.selectRoot("deleted");
    expect(test.enabled()).toBe(false);
    test.selectRoot("body");
    test.pendingForms.register(Symbol(), { mode: "staged", dirty: true, applying: false,
      valid: true, reset: vi.fn(), apply: () => true });
    expect(test.enabled()).toBe(false);
  });

  it.each(["selection", "session"] as const)("preserves a new %s during a pending write", async change => {
    const test = setup();
    let finish!: (ack: SceneResource) => void;
    test.patchObject.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = test.execute();
    await vi.waitFor(() => expect(test.patchObject).toHaveBeenCalledTimes(1));
    expect(test.enabled()).toBe(false);
    if (change === "selection") test.selectRoot("other");
    else test.isCurrentSessionScope.mockReturnValue(false);
    finish(test.ack);
    await pending;
    expect(test.showPanel).not.toHaveBeenCalled();
    expect(test.selection.get().kind).toBe("object.root");
    expect(test.resources.getRevision(MODEL_SCENE_PATH)).toBe(change === "selection" ? 8 : null);
  });

  it("reports revision conflicts and leaves the selection available for retry", async () => {
    const test = setup();
    test.patchObject.mockRejectedValueOnce(new Error("Scene revision conflict"));
    expect(await test.execute()).toMatchObject({ status: "failed", message: "Scene revision conflict" });
    expect(test.selection.get().kind).toBe("object.root");
    expect(test.showPanel).not.toHaveBeenCalled();
    expect(test.enabled()).toBe(true);
  });
});
