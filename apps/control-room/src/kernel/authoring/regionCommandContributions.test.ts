import { describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "../commands/CommandRegistry";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { MODEL_REGIONS_PATH } from "../api/apiPaths";
import { SelectionController } from "../selection/SelectionController";

import { REGION_COMMANDS } from "./regionCommandContributions";

function registryWithRegionCommands(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.attach(new EventBus<KernelEventMap>());
  for (const command of REGION_COMMANDS) {
    registry.register(command);
  }
  return registry;
}

function selectRegion(selection: SelectionController): void {
  selection.set(
    {
      kind: "object.region",
      label: "Core",
      nodeId: "model:object:film:regions:core",
      objectId: "film",
      ref: {
        kind: "object.region",
        nodeId: "model:object:film:regions:core",
        objectId: "film",
        regionId: "core",
        type: "scene-object",
        visualizationTargetId: "region:film:core",
      },
    },
    "test",
  );
}

function selectCoupling(selection: SelectionController): void {
  selection.set(
    {
      kind: "physics.coupling",
      label: "Core exchange",
      nodeId: "model:physics:couplings:exchange-core",
      objectId: null,
      ref: {
        couplingId: "exchange-core",
        kind: "physics.coupling",
        nodeId: "model:physics:couplings:exchange-core",
        type: "physics-coupling",
      },
    },
    "test",
  );
}

describe("REGION_COMMANDS", () => {
  it("duplicates and deletes the selected authored region through the model facade", async () => {
    const registry = registryWithRegionCommands();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    const duplicateObjectRegion = vi.fn(async () => ({}));
    const deleteObjectRegion = vi.fn(async () => ({}));
    selectRegion(selection);

    await registry.execute("regions.duplicate", {
      api: { model: { duplicateObjectRegion } } as never,
      selection,
      source: "test",
    });
    await registry.execute("regions.delete", {
      api: { model: { deleteObjectRegion } } as never,
      selection,
      source: "test",
    });

    expect(duplicateObjectRegion).toHaveBeenCalledWith("film", "core", {});
    expect(deleteObjectRegion).toHaveBeenCalledWith("film", "core");
  });

  it("moves the selected authored region through owner-scoped reorder requests", async () => {
    const registry = registryWithRegionCommands();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    const reorderObjectRegions = vi.fn(async () => ({}));
    selectRegion(selection);
    const resourceData = {
      [MODEL_REGIONS_PATH]: {
        geometry_realization_revision: 1,
        scene_revision: 7,
        regions: [
          {
            bounds_max: [0, 0, 0],
            bounds_min: [0, 0, 0],
            enabled: true,
            interaction_refs: [],
            material_ref: "mat",
            mesh_part_ids: [],
            name: "Edge",
            owner_object_id: "film",
            priority: 1,
            region_id: "edge",
            source: "authored_object_region",
            source_body_ids: [],
            source_object_ids: ["film"],
          },
          {
            bounds_max: [0, 0, 0],
            bounds_min: [0, 0, 0],
            enabled: true,
            interaction_refs: [],
            material_ref: "mat",
            mesh_part_ids: [],
            name: "Core",
            owner_object_id: "film",
            priority: 2,
            region_id: "core",
            source: "authored_object_region",
            source_body_ids: [],
            source_object_ids: ["film"],
          },
          {
            bounds_max: [0, 0, 0],
            bounds_min: [0, 0, 0],
            enabled: true,
            interaction_refs: [],
            material_ref: "mat",
            mesh_part_ids: [],
            name: "Shell",
            owner_object_id: "film",
            priority: 3,
            region_id: "shell",
            source: "authored_object_region",
            source_body_ids: [],
            source_object_ids: ["film"],
          },
        ],
      },
    };

    await registry.execute("regions.priority-up", {
      api: { model: { reorderObjectRegions } } as never,
      resourceData,
      selection,
      source: "test",
    });
    await registry.execute("regions.priority-down", {
      api: { model: { reorderObjectRegions } } as never,
      resourceData,
      selection,
      source: "test",
    });

    expect(reorderObjectRegions).toHaveBeenNthCalledWith(
      1,
      "film",
      ["core", "edge", "shell"],
    );
    expect(reorderObjectRegions).toHaveBeenNthCalledWith(
      2,
      "film",
      ["edge", "shell", "core"],
    );
  });

  it("disables and deletes the selected coupling through the model facade", async () => {
    const registry = registryWithRegionCommands();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    const patchCoupling = vi.fn(async () => ({}));
    const deleteCoupling = vi.fn(async () => ({}));
    selectCoupling(selection);

    await registry.execute("couplings.disable", {
      api: { model: { patchCoupling } } as never,
      selection,
      source: "test",
    });
    await registry.execute("couplings.delete", {
      api: { model: { deleteCoupling } } as never,
      selection,
      source: "test",
    });

    expect(patchCoupling).toHaveBeenCalledWith("exchange-core", { enabled: false });
    expect(deleteCoupling).toHaveBeenCalledWith("exchange-core");
  });
});
