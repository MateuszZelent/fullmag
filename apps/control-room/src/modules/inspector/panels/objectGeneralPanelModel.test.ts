import { describe, expect, it } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  resolveObjectGeneralPanelModel,
  resolveObjectMetricsPanelModel,
  summarizeGeometryValidationMessages,
} from "./objectGeneralPanelModel";

const baseSelection: Selection = {
  kind: "object.root",
  label: "Box",
  moduleSource: "test",
  nodeId: "model:object:box",
  objectId: "box",
  ref: {
    kind: "object.root",
    nodeId: "model:object:box",
    objectId: "box",
    type: "scene-object",
    visualizationTargetId: "object:box",
  },
};

describe("resolveObjectGeneralPanelModel", () => {
  it("reads committed object general data from SceneDocument", () => {
    const model = resolveObjectGeneralPanelModel(baseSelection, {
      objects: [
        {
          geometry: {
            geometry_kind: "Box",
            geometry_params: { size: [1e-9, 2e-9, 3e-9] },
          },
          id: "box",
          material_ref: "permalloy",
          name: "Box",
          notes: "Release candidate waveguide",
          region_name: "free",
          tags: ["mesh:dirty"],
        },
      ],
      revision: 4,
    });

    expect(model).toEqual({
      material: "permalloy",
      meshStatus: "mesh-stale",
      mode: "committed",
      name: "Box",
      notes: "Release candidate waveguide",
      objectId: "box",
      region: "free",
      revision: 4,
      shape: "Box",
      source: "SceneDocument",
    });
  });

  it("extracts object-scoped backend validation messages", () => {
    expect(
      summarizeGeometryValidationMessages(
        {
          diagnostics: [
            { message: "Box is outside universe", object_id: "box" },
            { message: "Cylinder radius is unsupported", object_id: "other" },
          ],
          nested: {
            issues: [
              { detail: "Material is missing", targetId: "object:box" },
            ],
          },
        },
        "box",
      ),
    ).toEqual(["Box is outside universe", "Material is missing"]);
  });

  it("formats object energy and magnetization metrics for the inspector", () => {
    expect(
      resolveObjectMetricsPanelModel({
        energies: {
          anisotropy: 4,
          demag: 2,
          dmi: 5,
          exchange: 1,
          total: 15,
          zeeman: 3,
        },
        has_solver_sample: true,
        magnetization_average: { mx: 0.25, my: 0.5, mz: 0.75 },
        object_id: "box",
        revision: 21,
        source: "solver_per_object",
        step: 7,
        time_seconds: 4.2e-12,
      }),
    ).toEqual({
      anisotropy: "4.000000e+0 J",
      demag: "2.000000e+0 J",
      dmi: "5.000000e+0 J",
      exchange: "1.000000e+0 J",
      magnetization: "(0.250000, 0.500000, 0.750000)",
      sample: "step 7 @ 4.200000e-12 s",
      source: "solver_per_object",
      status: "computed",
      total: "1.500000e+1 J",
      zeeman: "3.000000e+0 J",
    });
  });

  it("keeps partial object metrics from crashing the inspector", () => {
    expect(
      resolveObjectMetricsPanelModel({
        energies: {},
        has_solver_sample: false,
        magnetization_average: { mx: 1, my: 0, mz: 0 },
        object_id: "box",
        revision: 22,
        source: "fixture",
        step: 0,
        time_seconds: 0,
      } as unknown as Parameters<typeof resolveObjectMetricsPanelModel>[0]),
    ).toEqual({
      anisotropy: "unavailable",
      demag: "unavailable",
      dmi: "unavailable",
      exchange: "unavailable",
      magnetization: "(1.000000, 0.000000, 0.000000)",
      sample: "step 0 @ 0.000000e+0 s",
      source: "fixture",
      status: "initial",
      total: "unavailable",
      zeeman: "unavailable",
    });
  });
});
