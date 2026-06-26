import { describe, expect, it } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  createObjectExtensionActivationState,
  objectExtensionActivationKey,
  resolveAvailableObjectExtensions,
  resolveActiveObjectExtensionExplorerItems,
  resolveObjectExtensionsSectionModel,
  setObjectExtensionEnabled,
} from "./ObjectExtensionsSectionModel";

const objectRootSelection: Selection = {
  kind: "object.root",
  label: "permalloy_layer",
  moduleSource: "test",
  nodeId: "model:object:permalloy_layer",
  objectId: "permalloy_layer",
  ref: {
    kind: "object.root",
    nodeId: "model:object:permalloy_layer",
    objectId: "permalloy_layer",
    type: "scene-object",
    visualizationTargetId: "object:permalloy_layer",
  },
};

describe("ObjectExtensionsSectionModel", () => {
  it("exposes Topological Charge only for committed object root selections", () => {
    expect(resolveAvailableObjectExtensions(objectRootSelection).map((item) => item.id))
      .toEqual(["topological_charge"]);

    expect(
      resolveAvailableObjectExtensions({
        ...objectRootSelection,
        kind: "object.geometry",
      }).map((item) => item.id),
    ).toEqual([]);
  });

  it("stores activation per object and extension without mutating the previous state", () => {
    const initial = createObjectExtensionActivationState();
    const enabled = setObjectExtensionEnabled(
      initial,
      "permalloy_layer",
      "topological_charge",
      true,
    );

    expect(initial.enabled[objectExtensionActivationKey("permalloy_layer", "topological_charge")])
      .toBeUndefined();
    expect(enabled.enabled[objectExtensionActivationKey("permalloy_layer", "topological_charge")])
      .toBe(true);
    expect(enabled.enabled[objectExtensionActivationKey("cofeb_ring", "topological_charge")])
      .toBeUndefined();
  });

  it("builds a compact section model with active count and disabled module rows", () => {
    const activation = createObjectExtensionActivationState();

    expect(
      resolveObjectExtensionsSectionModel(objectRootSelection, activation),
    ).toEqual({
      activeCount: 0,
      badge: undefined,
      extensions: [
        {
          enabled: false,
          id: "topological_charge",
          label: "Topological Charge",
          status: "disabled",
          summary: "disabled",
        },
      ],
      visible: true,
    });
  });

  it("projects enabled object extensions into explorer child node snapshots", () => {
    const activation = setObjectExtensionEnabled(
      createObjectExtensionActivationState(),
      "permalloy_layer",
      "topological_charge",
      true,
    );

    expect(
      resolveActiveObjectExtensionExplorerItems("permalloy_layer", activation),
    ).toEqual([
      {
        id: "topological_charge",
        label: "Topological Charge",
        status: "ready",
      },
    ]);
    expect(resolveActiveObjectExtensionExplorerItems("cofeb_ring", activation))
      .toEqual([]);
  });
});
