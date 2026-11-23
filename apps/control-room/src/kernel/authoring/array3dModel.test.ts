import { describe, expect, it, vi } from "vitest";

import { MODEL_SCENE_PATH } from "../api/apiPaths";
import { CommandRegistry } from "../commands/CommandRegistry";
import type { CommandContext } from "../commands/commandTypes";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { ResourceInvalidationController } from "../resources/ResourceInvalidationController";
import { SelectionController } from "../selection/SelectionController";
import {
  applyArray3DPreset,
  axisStepVectorM,
  canonicalAxisIndices,
  computeArray3DBudgetStatus,
  computeArray3DInstanceCount,
  computeArray3DInstanceTransforms,
  computeArray3DWorldBounds,
  defaultArrayAxisSpec,
  MAX_ARRAY_INSTANCES_FDM,
  MAX_ARRAY_INSTANCES_FEM_OCC,
  MAX_EXPANDED_SCENE_OBJECTS,
  parseArray3DGeometry,
} from "./array3dModel";
import { GEOMETRY_LIFECYCLE_COMMANDS } from "./geometryLifecycleCommandContributions";

describe("Array3D lattice model & command contract (Etap C)", () => {
  it("computes canonical positive, negative, symmetric (even & odd), and disabled indices 1:1", () => {
    expect(
      canonicalAxisIndices({ count: 4, direction: "positive", enabled: true }),
    ).toEqual([0, 1, 2, 3]);
    // Negative preserves order [0, -1, -2, -3] for stable IDs.
    expect(
      canonicalAxisIndices({ count: 4, direction: "negative", enabled: true }),
    ).toEqual([0, -1, -2, -3]);
    expect(
      canonicalAxisIndices({ count: 2, direction: "symmetric", enabled: true }),
    ).toEqual([-0.5, 0.5]);
    expect(
      canonicalAxisIndices({ count: 3, direction: "symmetric", enabled: true }),
    ).toEqual([-1, 0, 1]);
    expect(
      canonicalAxisIndices({ count: 5, direction: "positive", enabled: false }),
    ).toEqual([0]);
  });

  it("produces exact Hexagonal XY Bravais preset (dy = p*sqrt(3)/2, extra_x = p/2)", () => {
    const p = 100e-9;
    const hex = applyArray3DPreset("hexagonal_xy", p);
    expect(hex[0].enabled).toBe(true);
    expect(hex[0].pitch_m).toBeCloseTo(p, 18);
    expect(hex[1].enabled).toBe(true);
    expect(hex[1].pitch_m).toBeCloseTo((p * Math.sqrt(3)) / 2, 18);
    expect(hex[1].step_translation_extra_m).toEqual([p / 2, 0, 0]);
    expect(hex[2].enabled).toBe(false);

    const vy = axisStepVectorM(hex[1], [20e-9, 20e-9, 10e-9]);
    expect(vy[0]).toBeCloseTo(50e-9, 18);
    expect(vy[1]).toBeCloseTo((100e-9 * Math.sqrt(3)) / 2, 18);
    expect(vy[2]).toBe(0);
  });

  it("enforces budget thresholds (256 expand, 2500 FEM/OCC, 100000 FDM)", () => {
    expect(
      computeArray3DBudgetStatus(MAX_EXPANDED_SCENE_OBJECTS, "expand_to_objects").level,
    ).toBe("ok");
    expect(
      computeArray3DBudgetStatus(MAX_EXPANDED_SCENE_OBJECTS + 1, "expand_to_objects"),
    ).toMatchObject({ canExpandToObjects: false, level: "error" });
    expect(
      computeArray3DBudgetStatus(MAX_ARRAY_INSTANCES_FEM_OCC + 1, "modifier_in_object"),
    ).toMatchObject({ exceedsFemOccLimit: true, level: "warn" });
    expect(
      computeArray3DBudgetStatus(MAX_ARRAY_INSTANCES_FDM + 1, "modifier_in_object"),
    ).toMatchObject({ exceedsFdmLimit: true, level: "error" });
  });

  it("computes bounding_box_gap steps, world bounds, and step rotation/scale transforms", () => {
    const axes = [
      defaultArrayAxisSpec("x", {
        count: 2,
        direction: "positive",
        enabled: true,
        gap_m: 10e-9,
        relative_factor: 1,
        spacing_mode: "bounding_box_gap",
        step_rotation_euler_deg: [0, 0, 15],
        step_scale_factor: [1, 1, 2],
      }),
      defaultArrayAxisSpec("y", { count: 1, enabled: false }),
      defaultArrayAxisSpec("z", { count: 1, enabled: false }),
    ] as [ReturnType<typeof defaultArrayAxisSpec>, ReturnType<typeof defaultArrayAxisSpec>, ReturnType<typeof defaultArrayAxisSpec>];

    expect(computeArray3DInstanceCount(axes)).toBe(2);
    const bounds = computeArray3DWorldBounds(axes, {
      max: [20e-9, 10e-9, 5e-9],
      min: [-20e-9, -10e-9, -5e-9],
    });
    // child extent X = 40nm, gap = 10nm -> step = 50nm -> max.x = 20nm + 50nm = 70nm
    expect(bounds.min[0]).toBeCloseTo(-20e-9, 15);
    expect(bounds.max[0]).toBeCloseTo(70e-9, 15);

    const instances = computeArray3DInstanceTransforms(axes, [40e-9, 20e-9, 10e-9]);
    expect(instances).toHaveLength(2);
    expect(instances[1]?.translation[0]).toBeCloseTo(50e-9, 15);
    expect(instances[1]?.rotationEulerDeg).toEqual([0, 0, 15]);
    expect(instances[1]?.scale).toEqual([1, 1, 2]);

    const parsed = parseArray3DGeometry({
      geometry_kind: "Array3D",
      geometry_params: {
        axes,
        child: { geometry_kind: "Box", geometry_params: { size: [40e-9, 20e-9, 10e-9] } },
        merge_overlapping: false,
      },
    });
    expect(parsed?.axes[0].count).toBe(2);
    expect(parsed?.mergeOverlapping).toBe(false);
  });

  it("dispatches apply_array_3d transaction via geometry.apply-array-3d command", async () => {
    const registry = new CommandRegistry();
    for (const command of GEOMETRY_LIFECYCLE_COMMANDS) {
      registry.register(command);
    }
    const bus = new EventBus<KernelEventMap>();
    const selection = new SelectionController(bus);
    const resources = new ResourceInvalidationController(bus);
    const commitTransaction = vi.fn(async () => ({
      committed_scene: { revision: 31 },
      scene_revision: 31,
      transaction_kind: "apply_array_3d",
    }));

    selection.set(
      {
        kind: "object.geometry.node",
        label: "Hole",
        nodeId: "model:object:film_1:geometry:op_hole",
        objectId: "film_1",
        ref: {
          geometryNodeId: "op_hole",
          kind: "object.geometry.node",
          nodeId: "model:object:film_1:geometry:op_hole",
          objectId: "film_1",
          operandId: "op_hole",
          type: "scene-object",
          visualizationTargetId: "object:film_1",
        },
      },
      "test",
    );

    const axes = applyArray3DPreset("rectangular_xy", 80e-9);
    expect(
      await registry.execute("geometry.apply-array-3d", {
        api: { model: { commitTransaction } } as unknown as CommandContext["api"],
        input: { axes, merge_overlapping: false, realization: "modifier_in_object" },
        resourceData: { [MODEL_SCENE_PATH]: { revision: 30 } },
        resources,
        selection,
        source: "test",
      }),
    ).toEqual({ status: "completed" });

    expect(commitTransaction).toHaveBeenCalledWith({
      axes,
      base_revision: 30,
      kind: "apply_array_3d",
      merge_overlapping: false,
      object_id: "film_1",
      realization: "modifier_in_object",
      target_operand_id: "op_hole",
    });
  });
});
