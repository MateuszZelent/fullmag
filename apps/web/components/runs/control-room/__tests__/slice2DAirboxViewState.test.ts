import { describe, expect, it } from "vitest";

import type { FemMeshPart, MeshEntityViewStateMap } from "@/lib/session/types";
import { resolveSlice2DAirboxViewState } from "../slice2DAirboxViewState";

function part(overrides: Partial<FemMeshPart>): FemMeshPart {
  return {
    id: "part:air",
    label: "air",
    role: "air",
    object_id: null,
    geometry_id: "air_geom",
    material_id: null,
    element_start: 0,
    element_count: 1,
    boundary_face_start: 0,
    boundary_face_count: 1,
    boundary_face_indices: [],
    node_start: 0,
    node_count: 2,
    node_indices: [],
    surface_faces: [],
    bounds_min: null,
    bounds_max: null,
    ...overrides,
  };
}

describe("resolveSlice2DAirboxViewState", () => {
  it("overrides only airbox-related parts for the 2D slice view", () => {
    const meshEntityViewState: MeshEntityViewStateMap = {
      "part:air": {
        visible: true,
        geometryVisible: true,
        renderMode: "surface+edges",
        renderPasses: { surface: true, wireframe: true, points: false },
        opacity: 28,
        colorField: "none",
      },
      "part:magnet": {
        visible: true,
        geometryVisible: true,
        renderMode: "surface+edges",
        renderPasses: { surface: true, wireframe: true, points: false },
        opacity: 100,
        colorField: "orientation",
      },
    };

    const next = resolveSlice2DAirboxViewState({
      meshParts: [
        part({ id: "part:air", role: "air" }),
        part({ id: "part:outer", role: "outer_boundary" }),
        part({ id: "part:magnet", role: "magnetic_object" }),
      ],
      meshEntityViewState,
      visible: false,
      renderMode: "points",
    });

    expect(next).not.toBe(meshEntityViewState);
    expect(next["part:air"]).toMatchObject({
      visible: false,
      geometryVisible: false,
      renderMode: "points",
      renderPasses: { surface: false, wireframe: false, points: true },
    });
    expect(next["part:outer"]).toMatchObject({
      visible: false,
      geometryVisible: false,
      renderMode: "points",
      renderPasses: { surface: false, wireframe: false, points: true },
    });
    expect(next["part:magnet"]).toBe(meshEntityViewState["part:magnet"]);
    expect(meshEntityViewState["part:air"]).toMatchObject({
      visible: true,
      renderMode: "surface+edges",
      renderPasses: { surface: true, wireframe: true, points: false },
    });
  });

  it("maps 2D airbox render modes to independent render passes", () => {
    expect(
      resolveSlice2DAirboxViewState({
        meshParts: [part({})],
        meshEntityViewState: {},
        visible: true,
        renderMode: "surface+edges",
      })["part:air"],
    ).toMatchObject({
      renderMode: "surface+edges",
      renderPasses: { surface: true, wireframe: true, points: false },
    });
  });

  it("returns the original state object when there are no airbox parts", () => {
    const meshEntityViewState: MeshEntityViewStateMap = {};
    const next = resolveSlice2DAirboxViewState({
      meshParts: [part({ id: "part:magnet", role: "magnetic_object" })],
      meshEntityViewState,
      visible: true,
      renderMode: "wireframe",
    });

    expect(next).toBe(meshEntityViewState);
  });
});
