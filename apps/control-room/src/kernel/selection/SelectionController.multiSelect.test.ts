import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { SelectionController } from "./SelectionController";
import {
  EMPTY_SELECTION,
  orderedSelectedObjectIds,
  selectionRefEquals,
  selectionRoleBadgeForObject,
  selectionSnapshotEquals,
} from "./selectionTypes";

function objectPatch(id: string) {
  return {
    kind: "object.root",
    label: id,
    nodeId: `model:object:${id}`,
    objectId: id,
    ref: {
      kind: "object.root" as const,
      nodeId: `model:object:${id}`,
      objectId: id,
      type: "scene-object" as const,
      visualizationTargetId: `object:${id}` as const,
    },
  };
}

describe("SelectionController multi-selection (Etap B)", () => {
  it("preserves backward compatibility with EMPTY_SELECTION and single selection", () => {
    const bus = new EventBus<KernelEventMap>();
    const controller = new SelectionController(bus);
    expect(controller.get()).toEqual(EMPTY_SELECTION);
    expect(controller.getSelectedObjectIds()).toEqual([]);

    controller.set(objectPatch("box_a"), "explorer");
    expect(controller.get().selectedObjectIds).toBeUndefined();
    expect(controller.getSelectedObjectIds()).toEqual(["box_a"]);
    expect(selectionRoleBadgeForObject(controller.get(), "box_a")).toBeNull();
  });

  it("maintains ordered selection on Ctrl/Cmd toggle with A·Base and B1..Bk badges", () => {
    const bus = new EventBus<KernelEventMap>();
    const controller = new SelectionController(bus);
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.set(objectPatch("box_a"), "explorer");
    controller.toggleObjectSelection("cyl_b", objectPatch("cyl_b"), "explorer");
    controller.toggleObjectSelection("sph_c", objectPatch("sph_c"), "viewport-3d");

    const state = controller.get();
    expect(orderedSelectedObjectIds(state)).toEqual(["box_a", "cyl_b", "sph_c"]);
    expect(selectionRoleBadgeForObject(state, "box_a")).toBe("A · Base");
    expect(selectionRoleBadgeForObject(state, "cyl_b")).toBe("B1");
    expect(selectionRoleBadgeForObject(state, "sph_c")).toBe("B2");
    expect(listener).toHaveBeenCalledTimes(3);

    // Toggling cyl_b removes it while preserving order of remaining objects.
    controller.toggleObjectSelection("cyl_b", objectPatch("cyl_b"), "explorer");
    expect(orderedSelectedObjectIds(controller.get())).toEqual(["box_a", "sph_c"]);
    expect(selectionRoleBadgeForObject(controller.get(), "sph_c")).toBe("B1");

    // Plain single-select clears multi-selection cleanly.
    controller.set(objectPatch("sph_c"), "explorer");
    expect(controller.get().selectedObjectIds).toBeUndefined();
    expect(orderedSelectedObjectIds(controller.get())).toEqual(["sph_c"]);
  });

  it("supports Shift+Click range selection preserving anchor as Base A", () => {
    const bus = new EventBus<KernelEventMap>();
    const controller = new SelectionController(bus);
    const visible = ["obj_1", "obj_2", "obj_3", "obj_4"];

    controller.set(objectPatch("obj_3"), "explorer");
    controller.rangeSelectObjects(visible, "obj_1", objectPatch("obj_1"), "explorer");

    expect(orderedSelectedObjectIds(controller.get())).toEqual([
      "obj_3",
      "obj_2",
      "obj_1",
    ]);
    expect(selectionRoleBadgeForObject(controller.get(), "obj_3")).toBe("A · Base");
    expect(selectionRoleBadgeForObject(controller.get(), "obj_2")).toBe("B1");
    expect(selectionRoleBadgeForObject(controller.get(), "obj_1")).toBe("B2");
  });

  it("compares selectedObjectIds in selectionSnapshotEquals and operandId in selectionRefEquals", () => {
    const base = { ...EMPTY_SELECTION, objectId: "a", selectedObjectIds: ["a", "b"] };
    const swapped = { ...EMPTY_SELECTION, objectId: "a", selectedObjectIds: ["b", "a"] };
    expect(selectionSnapshotEquals(base, swapped)).toBe(false);

    const ref1 = {
      geometryNodeId: "op1",
      kind: "object.geometry.node" as const,
      nodeId: "model:object:a:geometry:op1",
      objectId: "a",
      operandId: "op1",
      type: "scene-object" as const,
      visualizationTargetId: "object:a" as const,
    };
    const ref2 = { ...ref1, operandId: "op2", geometryNodeId: "op2" };
    expect(selectionRefEquals(ref1, ref1)).toBe(true);
    expect(selectionRefEquals(ref1, ref2)).toBe(false);
  });
});
