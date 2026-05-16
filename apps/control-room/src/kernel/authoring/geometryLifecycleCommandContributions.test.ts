import { describe, expect, it, vi } from "vitest";

import {
  MESHING_BUILDS_CURRENT_PATH,
  MESHING_OBJECT_QUALITY_PATH,
  MESHING_OBJECT_REPORT_PATH,
  MESHING_OBJECT_TOPOLOGY_PATH,
  MODEL_GEOMETRY_CAPABILITIES_PATH,
  MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_SCENE_PATH,
} from "../api/apiPaths";
import type { CommandContext } from "../commands/commandTypes";
import { CommandRegistry } from "../commands/CommandRegistry";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { ResourceInvalidationController } from "../resources/ResourceInvalidationController";
import { SelectionController } from "../selection/SelectionController";

import { GEOMETRY_LIFECYCLE_COMMANDS } from "./geometryLifecycleCommandContributions";

function registryWithLifecycleCommands(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.attach(new EventBus<KernelEventMap>());
  for (const command of GEOMETRY_LIFECYCLE_COMMANDS) {
    registry.register(command);
  }
  return registry;
}

function selectBox(selection: SelectionController): void {
  selection.set(
    {
      kind: "object.mesh",
      label: "Box",
      nodeId: "model:object:box:mesh",
      objectId: "box",
      ref: {
        kind: "object.mesh",
        nodeId: "model:object:box:mesh",
        objectId: "box",
        type: "scene-object",
        visualizationTargetId: "object:box",
      },
    },
    "test",
  );
}

describe("geometry lifecycle command contributions", () => {
  it("submits selected-object mesh builds through the command registry", async () => {
    const registry = registryWithLifecycleCommands();
    const bus = new EventBus<KernelEventMap>();
    const selection = new SelectionController(bus);
    const resources = new ResourceInvalidationController(bus);
    selectBox(selection);
    const submit = vi.fn(async () => ({
      accepted: true,
      command_id: "cmd-1",
      error: null,
    }));

    expect(
      registry.isEnabled("mesh.build-selected", {
        selection,
        source: "test",
      }),
    ).toBe(true);

    const result = await registry.execute("mesh.build-selected", {
      api: {
        commands: { submit },
      } as never,
      resources,
      selection,
      source: "test",
    });

    expect(result).toEqual({ status: "completed" });
    expect(submit).toHaveBeenCalledWith({
      kind: "mesh_build",
      mesh_reason: "selected-object",
      mesh_target: { kind: "object_mesh", object_id: "box" },
    });
    expect(resources.getRevision(MESHING_BUILDS_CURRENT_PATH)).toBe("cmd-1");
    expect(
      resources.getRevision(
        MESHING_OBJECT_TOPOLOGY_PATH.replace("{object_id}", "box"),
      ),
    ).toBe("cmd-1");
    expect(
      resources.getRevision(
        MESHING_OBJECT_REPORT_PATH.replace("{object_id}", "box"),
      ),
    ).toBe("cmd-1");
    expect(
      resources.getRevision(
        MESHING_OBJECT_QUALITY_PATH.replace("{object_id}", "box"),
      ),
    ).toBe("cmd-1");
  });

  it("disables object-scoped commands without object selection", () => {
    const registry = registryWithLifecycleCommands();
    const selection = new SelectionController(new EventBus<KernelEventMap>());

    expect(
      registry.isEnabled("mesh.build-selected", {
        selection,
        source: "test",
      }),
    ).toBe(false);
    expect(
      registry.isEnabled("geometry.delete-object", {
        selection,
        source: "test",
      }),
    ).toBe(false);
  });

  it("disables primitive commands when geometry capabilities reject them", () => {
    const registry = registryWithLifecycleCommands();
    const context: CommandContext = {
      resourceData: {
        [MODEL_GEOMETRY_CAPABILITIES_PATH]: {
          primitives: { box: true, cylinder: false, sphere: true },
        },
      },
      source: "test",
    };

    expect(registry.isEnabled("geometry.add-box", context)).toBe(true);
    expect(registry.isEnabled("geometry.add-cylinder", context)).toBe(false);
    expect(
      registry.get("geometry.add-cylinder")?.disabledReason?.(context),
    ).toBe("Backend does not expose cylinder geometry authoring.");
  });

  it("disables selected mesh build for validation blockers", () => {
    const registry = registryWithLifecycleCommands();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    selectBox(selection);
    const context: CommandContext = {
      resourceData: {
        [MODEL_GEOMETRY_VALIDATION_PATH]: {
          blockers: [
            {
              message: "Box exceeds universe bounds",
              object_id: "box",
              severity: "error",
            },
          ],
        },
      },
      selection,
      source: "test",
    };

    expect(registry.isEnabled("mesh.build-selected", context)).toBe(false);
    expect(registry.get("mesh.build-selected")?.disabledReason?.(context)).toBe(
      "Resolve geometry validation blockers before building this mesh.",
    );
  });

  it("disables selected mesh build while an object mesh build is running", () => {
    const registry = registryWithLifecycleCommands();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    selectBox(selection);
    const context: CommandContext = {
      resourceData: {
        [MESHING_BUILDS_CURRENT_PATH]: {
          active_build: {
            mesh_target: { kind: "object_mesh", object_id: "box" },
            status: "running",
          },
        },
      },
      selection,
      source: "test",
    };

    expect(registry.isEnabled("mesh.build-selected", context)).toBe(false);
    expect(registry.get("mesh.build-selected")?.disabledReason?.(context)).toBe(
      "A mesh build is already running for this object.",
    );
  });

  it("commits delete transactions and clears deleted object selection", async () => {
    const registry = registryWithLifecycleCommands();
    const bus = new EventBus<KernelEventMap>();
    const selection = new SelectionController(bus);
    const resources = new ResourceInvalidationController(bus);
    selection.set(
      {
        kind: "object.root",
        label: "Box",
        nodeId: "model:object:box",
        objectId: "box",
        ref: {
          kind: "object.root",
          nodeId: "model:object:box",
          objectId: "box",
          type: "scene-object",
          visualizationTargetId: "object:box",
        },
      },
      "test",
    );
    const commitTransaction = vi.fn(async () => ({
      committed_scene: { revision: 15 },
      scene_revision: 15,
      transaction_kind: "delete_object",
    }));

    const result = await registry.execute("geometry.delete-object", {
      api: {
        model: { commitTransaction },
      } as never,
      resources,
      selection,
      source: "test",
    });

    expect(result).toEqual({ status: "completed" });
    expect(commitTransaction).toHaveBeenCalledWith({
      kind: "delete_object",
      object_id: "box",
    });
    expect(selection.get().objectId).toBeNull();
    expect(resources.getRevision(MODEL_SCENE_PATH)).toBe(15);
    expect(resources.getRevision(MODEL_GEOMETRY_DIAGNOSTICS_PATH)).toBe(15);
  });

  it("commits primitive drafts as create-object transactions and selects the committed object", async () => {
    const registry = registryWithLifecycleCommands();
    const bus = new EventBus<KernelEventMap>();
    const selection = new SelectionController(bus);
    const resources = new ResourceInvalidationController(bus);
    const now = vi.spyOn(Date, "now").mockReturnValue(12345);
    selection.set(
      {
        kind: "builder.primitive",
        label: "New box",
        nodeId: "geometry:draft:box",
        objectId: null,
        ref: null,
      },
      "test",
    );
    const commitTransaction = vi.fn(async () => ({
      committed_scene: { revision: 21 },
      scene_revision: 21,
      transaction_kind: "create_object",
    }));

    const result = await registry.execute("geometry.commit-object-draft", {
      api: {
        model: { commitTransaction },
      } as never,
      resources,
      selection,
      source: "test",
    });

    expect(result).toEqual({ status: "completed" });
    expect(commitTransaction).toHaveBeenCalledWith({
      geometry: {
        geometry_kind: "Box",
        geometry_params: { size: [1e-7, 1e-7, 1e-8] },
      },
      kind: "create_object",
      name: "New box",
      object_id: "box-9ix",
      transform: {
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        translation: [0, 0, 0],
      },
    });
    expect(selection.get()).toMatchObject({
      kind: "object.root",
      label: "New box",
      nodeId: "model:object:box-9ix",
      objectId: "box-9ix",
      ref: {
        kind: "object.root",
        nodeId: "model:object:box-9ix",
        objectId: "box-9ix",
        type: "scene-object",
        visualizationTargetId: "object:box-9ix",
      },
    });
    expect(resources.getRevision(MODEL_SCENE_PATH)).toBe(21);
    now.mockRestore();
  });

  it("keeps the primitive draft selected when create-object commit fails", async () => {
    const registry = registryWithLifecycleCommands();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    selection.set(
      {
        kind: "builder.primitive",
        label: "New sphere",
        nodeId: "geometry:draft:sphere",
        objectId: null,
        ref: null,
      },
      "test",
    );

    const result = await registry.execute("geometry.commit-object-draft", {
      api: {
        model: {
          commitTransaction: vi.fn(async () => {
            throw new Error("base revision conflict");
          }),
        },
      } as never,
      selection,
      source: "test",
    });

    expect(result).toEqual({
      message: "base revision conflict",
      status: "failed",
    });
    expect(selection.get()).toMatchObject({
      kind: "builder.primitive",
      label: "New sphere",
      nodeId: "geometry:draft:sphere",
      objectId: null,
      ref: null,
    });
  });
});
