import { afterEach, describe, expect, it, vi } from "vitest";

import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { SceneResource } from "@/kernel/api/apiTypes";
import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { SelectionController } from "@/kernel/selection/SelectionController";

import { deleteObjectDialogStore } from "./deleteObjectDialogStore";
import { GEOMETRY_LIFECYCLE_COMMANDS } from "./geometryLifecycleCommandContributions";

function createRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  for (const command of GEOMETRY_LIFECYCLE_COMMANDS) {
    registry.register(command);
  }
  return registry;
}

describe("deleteObjectDialogStore & geometry.delete-object confirmation flow", () => {
  afterEach(() => {
    deleteObjectDialogStore.reset();
  });

  it("opens DeleteObjectImpactDialog when a workspace host is mounted and cancels cleanly without deleting", async () => {
    const unregister = deleteObjectDialogStore.registerHost();
    const registry = createRegistry();
    const bus = new EventBus<KernelEventMap>();
    const selection = new SelectionController(bus);
    const resources = new ResourceInvalidationController(bus);
    const commitTransaction = vi.fn();

    const scene = {
      objects: [{ id: "film_1", name: "Film" }],
      revision: 4,
    } as unknown as SceneResource;

    const pendingResult = registry.execute("geometry.delete-object", {
      api: { model: { commitTransaction } } as never,
      input: { objectId: "film_1" },
      resourceData: { [MODEL_SCENE_PATH]: scene },
      resources,
      selection,
      source: "explorer",
    });

    const request = deleteObjectDialogStore.getSnapshot();
    expect(request).not.toBeNull();
    expect(request?.objectId).toBe("film_1");
    expect(commitTransaction).not.toHaveBeenCalled();

    deleteObjectDialogStore.cancel(request?.requestId);
    const result = await pendingResult;
    expect(result).toMatchObject({ status: "cancelled" });
    expect(commitTransaction).not.toHaveBeenCalled();
    expect(deleteObjectDialogStore.getSnapshot()).toBeNull();
    unregister();
  });

  it("commits delete_object only after explicit confirmation in DeleteObjectImpactDialog", async () => {
    const unregister = deleteObjectDialogStore.registerHost();
    const registry = createRegistry();
    const bus = new EventBus<KernelEventMap>();
    const selection = new SelectionController(bus);
    const resources = new ResourceInvalidationController(bus);
    const commitTransaction = vi.fn(async () => ({
      committed_scene: { objects: [], revision: 5 },
      scene_revision: 5,
      transaction_kind: "delete_object",
    }));

    const pendingResult = registry.execute("geometry.delete-object", {
      api: { model: { commitTransaction } } as never,
      input: { objectId: "film_1" },
      resources,
      selection,
      source: "explorer",
    });

    const request = deleteObjectDialogStore.getSnapshot();
    expect(request?.objectId).toBe("film_1");
    expect(commitTransaction).not.toHaveBeenCalled();

    deleteObjectDialogStore.confirm(request?.requestId);
    const result = await pendingResult;
    expect(result).toEqual({ status: "completed" });
    expect(commitTransaction).toHaveBeenCalledWith({
      kind: "delete_object",
      object_id: "film_1",
    });
    unregister();
  });
});
