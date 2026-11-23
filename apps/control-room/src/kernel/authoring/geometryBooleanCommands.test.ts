import { beforeEach, describe, expect, it, vi } from "vitest";

import { MODEL_SCENE_PATH } from "../api/apiPaths";
import { CommandRegistry } from "../commands/CommandRegistry";
import type { CommandContext } from "../commands/commandTypes";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { ResourceInvalidationController } from "../resources/ResourceInvalidationController";
import { SelectionController } from "../selection/SelectionController";
import { geometryGhostVisibilityStore } from "../visualization/geometryGhostVisibilityStore";
import { GEOMETRY_LIFECYCLE_COMMANDS } from "./geometryLifecycleCommandContributions";

function createRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  for (const command of GEOMETRY_LIFECYCLE_COMMANDS) {
    registry.register(command);
  }
  return registry;
}

describe("Etap B geometry primitives, Boolean CSG, Modify & Operand commands", () => {
  beforeEach(() => {
    geometryGhostVisibilityStore.clear();
  });

  it("opens and commits Ellipsoid, Cone, Torus, and PolygonPrism drafts", async () => {
    const registry = createRegistry();
    const cases = [
      { commandId: "geometry.add-ellipsoid", expectedKind: "Ellipsoid", label: "New ellipsoid" },
      { commandId: "geometry.add-cone", expectedKind: "Cone", label: "New cone" },
      { commandId: "geometry.add-torus", expectedKind: "Torus", label: "New torus" },
      { commandId: "geometry.add-polygon-prism", expectedKind: "PolygonPrism", label: "New polygon prism" },
    ] as const;

    for (const testCase of cases) {
      const bus = new EventBus<KernelEventMap>();
      const selection = new SelectionController(bus);
      const resources = new ResourceInvalidationController(bus);
      const commitTransaction = vi.fn(async () => ({
        committed_scene: { revision: 12 },
        scene_revision: 12,
        transaction_kind: "create_object",
      }));

      expect(
        await registry.execute(testCase.commandId, { selection, source: "test" }),
      ).toEqual({ status: "completed" });
      expect(selection.get().kind).toBe("builder.primitive");
      expect(selection.get().label).toBe(testCase.label);

      expect(
        await registry.execute("geometry.commit-object-draft", {
          api: { model: { commitTransaction } } as unknown as CommandContext["api"],
          resourceData: { [MODEL_SCENE_PATH]: { revision: 11 } },
          resources,
          selection,
          source: "test",
        }),
      ).toEqual({ status: "completed" });

      expect(commitTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          base_revision: 11,
          geometry: expect.objectContaining({
            geometry_kind: testCase.expectedKind,
          }),
          kind: "create_object",
        }),
      );
    }
  });

  it("gates Boolean CSG on >= 2 selected objects and dispatches boolean_combine_objects", async () => {
    const registry = createRegistry();
    const bus = new EventBus<KernelEventMap>();
    const selection = new SelectionController(bus);
    const resources = new ResourceInvalidationController(bus);
    const commitTransaction = vi.fn(async () => ({
      committed_scene: { revision: 8 },
      scene_revision: 8,
      transaction_kind: "boolean_combine_objects",
    }));
    const api = { model: { commitTransaction } } as unknown as CommandContext["api"];

    selection.set({ kind: "object.root", label: "A", nodeId: "model:object:obj_a", objectId: "obj_a", ref: null }, "test");
    expect(
      registry.isEnabled("geometry.boolean-subtract", {
        api,
        resourceData: { [MODEL_SCENE_PATH]: { revision: 7 } },
        selection,
        source: "test",
      }),
    ).toBe(false);

    selection.toggleObjectSelection("obj_b", { kind: "object.root", label: "B", nodeId: "model:object:obj_b", objectId: "obj_b", ref: null }, "test");
    selection.toggleObjectSelection("obj_c", { kind: "object.root", label: "C", nodeId: "model:object:obj_c", objectId: "obj_c", ref: null }, "test");

    expect(
      await registry.execute("geometry.boolean-subtract", {
        api,
        resourceData: { [MODEL_SCENE_PATH]: { revision: 7 } },
        resources,
        selection,
        source: "test",
      }),
    ).toEqual({ status: "completed" });

    expect(commitTransaction).toHaveBeenCalledWith({
      base_revision: 7,
      keep_tools: false,
      kind: "boolean_combine_objects",
      op: "subtract",
      region_merge_policy: "keep_target_only",
      target_object_id: "obj_a",
      tool_object_ids: ["obj_b", "obj_c"],
    });

    // Imprint regions defaults region_merge_policy to promote_tools_to_regions.
    selection.setOrderedObjectSelection(["obj_a", "obj_b"], { kind: "object.root", label: "A", nodeId: "model:object:obj_a", objectId: "obj_a", ref: null }, "test");
    await registry.execute("geometry.boolean-imprint-regions", {
      api,
      resourceData: { [MODEL_SCENE_PATH]: { revision: 8 } },
      resources,
      selection,
      source: "test",
    });
    expect(commitTransaction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "boolean_combine_objects",
        op: "imprint_regions",
        region_merge_policy: "promote_tools_to_regions",
      }),
    );
  });

  it("dispatches duplicate_objects, split_by_plane, extract_operand, and operand reorder/toggle/ghost", async () => {
    const registry = createRegistry();
    const bus = new EventBus<KernelEventMap>();
    const selection = new SelectionController(bus);
    const resources = new ResourceInvalidationController(bus);
    const commitTransaction = vi.fn(async () => ({
      committed_scene: { revision: 15 },
      scene_revision: 15,
      transaction_kind: "ok",
    }));
    const api = { model: { commitTransaction } } as unknown as CommandContext["api"];
    const compositeScene = {
      objects: [
        {
          geometry: {
            geometry_kind: "Difference",
            geometry_params: {
              operands: [
                { enabled: true, geometry: { geometry_kind: "Box" }, label: "Base", operand_id: "op_a" },
                { enabled: true, geometry: { geometry_kind: "Cylinder" }, label: "Hole", operand_id: "op_b" },
              ],
            },
          },
          id: "film_1",
        },
      ],
      revision: 14,
    };

    selection.set({
      kind: "object.geometry.node",
      label: "Hole",
      nodeId: "model:object:film_1:geometry:op_b",
      objectId: "film_1",
      ref: {
        geometryNodeId: "op_b",
        kind: "object.geometry.node",
        nodeId: "model:object:film_1:geometry:op_b",
        objectId: "film_1",
        operandId: "op_b",
        type: "scene-object",
        visualizationTargetId: "object:film_1",
      },
    }, "test");

    await registry.execute("geometry.duplicate-objects", {
      api,
      resourceData: { [MODEL_SCENE_PATH]: compositeScene },
      resources,
      selection,
      source: "test",
    });
    expect(commitTransaction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        base_revision: 14,
        copy_regions: true,
        kind: "duplicate_objects",
        object_ids: ["film_1"],
      }),
    );

    await registry.execute("geometry.split-by-plane", {
      api,
      resourceData: { [MODEL_SCENE_PATH]: compositeScene },
      resources,
      selection,
      source: "test",
    });
    expect(commitTransaction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        base_revision: 14,
        kind: "separate_object",
        mode: "split_by_plane",
        object_id: "film_1",
      }),
    );

    await registry.execute("geometry.extract-operand", {
      api,
      resourceData: { [MODEL_SCENE_PATH]: compositeScene },
      resources,
      selection,
      source: "test",
    });
    expect(commitTransaction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        base_revision: 14,
        kind: "separate_object",
        mode: "extract_operand",
        object_id: "film_1",
        operand_id: "op_b",
      }),
    );

    await registry.execute("geometry.operand-move-up", {
      api,
      resourceData: { [MODEL_SCENE_PATH]: compositeScene },
      resources,
      selection,
      source: "test",
    });
    expect(commitTransaction).toHaveBeenLastCalledWith({
      base_revision: 14,
      kind: "update_boolean_operands",
      object_id: "film_1",
      reorder_operand_ids: ["op_b", "op_a"],
    });

    await registry.execute("geometry.operand-toggle", {
      api,
      resourceData: { [MODEL_SCENE_PATH]: compositeScene },
      resources,
      selection,
      source: "test",
    });
    expect(commitTransaction).toHaveBeenLastCalledWith({
      base_revision: 14,
      kind: "update_boolean_operands",
      object_id: "film_1",
      toggle_operand: { enabled: false, operand_id: "op_b" },
    });

    const callsBeforeGhost = commitTransaction.mock.calls.length;
    await registry.execute("geometry.operand-toggle-ghost", {
      api,
      resourceData: { [MODEL_SCENE_PATH]: compositeScene },
      resources,
      selection,
      source: "test",
    });
    expect(commitTransaction).toHaveBeenCalledTimes(callsBeforeGhost);
    expect(geometryGhostVisibilityStore.isGhostVisible("film_1", "op_b")).toBe(true);

    // Legacy 2-operand dict ({ base, tool }) supports operand-move-up & operand-toggle.
    const legacyScene = {
      objects: [
        {
          geometry: {
            geometry_kind: "Difference",
            geometry_params: {
              base: { geometry_kind: "Box" },
              tool: { geometry_kind: "Cylinder" },
            },
          },
          id: "legacy_1",
        },
      ],
      revision: 20,
    };
    await registry.execute("geometry.operand-move-up", {
      api,
      input: { objectId: "legacy_1", operandId: "tool" },
      resourceData: { [MODEL_SCENE_PATH]: legacyScene },
      resources,
      selection,
      source: "test",
    });
    expect(commitTransaction).toHaveBeenLastCalledWith({
      base_revision: 20,
      kind: "update_boolean_operands",
      object_id: "legacy_1",
      reorder_operand_ids: ["tool", "base"],
    });
    await registry.execute("geometry.operand-toggle", {
      api,
      input: { objectId: "legacy_1", operandId: "tool" },
      resourceData: { [MODEL_SCENE_PATH]: legacyScene },
      resources,
      selection,
      source: "test",
    });
    expect(commitTransaction).toHaveBeenLastCalledWith({
      base_revision: 20,
      kind: "update_boolean_operands",
      object_id: "legacy_1",
      toggle_operand: { enabled: false, operand_id: "tool" },
    });
  });
});
