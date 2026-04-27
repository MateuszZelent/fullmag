import { describe, expect, it } from "vitest";

import type { FemMeshPart, MeshEntityViewStateMap } from "@/lib/session/types";
import { buildDenseFemVectorField, deriveFemVectorScopes } from "../femVectorScopes";

function part(overrides: Partial<FemMeshPart>): FemMeshPart {
  return {
    id: "part:free",
    label: "free",
    role: "magnetic_object",
    object_id: "free",
    geometry_id: "free_geom",
    material_id: "mat",
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

describe("deriveFemVectorScopes", () => {
  it("uses an object scope for the only visible magnetic object when airbox is hidden", () => {
    expect(
      deriveFemVectorScopes({
        meshParts: [part({})],
        meshEntityViewState: {},
        airMeshVisible: false,
      }),
    ).toEqual([{ kind: "object", id: "free" }]);
  });

  it("keeps magnetic object scope when the airbox is visible for magnetic-only quantities", () => {
    expect(
      deriveFemVectorScopes({
        meshParts: [part({}), part({ id: "part:air", role: "air", object_id: null })],
        meshEntityViewState: {},
        airMeshVisible: true,
        selectedFieldDomain: "magnetic_only",
      }),
    ).toEqual([{ kind: "object", id: "free" }]);
  });

  it("uses full scope for full-domain quantities", () => {
    expect(
      deriveFemVectorScopes({
        meshParts: [part({}), part({ id: "part:air", role: "air", object_id: null })],
        meshEntityViewState: {},
        airMeshVisible: true,
        selectedFieldDomain: "full_domain",
      }),
    ).toEqual([{ kind: "full" }]);
  });

  it("does not force full scope for airbox vectors on magnetic-only quantities", () => {
    expect(
      deriveFemVectorScopes({
        meshParts: [part({}), part({ id: "part:air", role: "air", object_id: null })],
        meshEntityViewState: {},
        airMeshVisible: true,
        vectorDomainFilter: "airbox_only",
        selectedFieldDomain: "magnetic_only",
      }),
    ).toEqual([{ kind: "object", id: "free" }]);
  });

  it("falls back to full scope when no mesh parts are available", () => {
    expect(
      deriveFemVectorScopes({
        meshParts: [],
        meshEntityViewState: {},
        airMeshVisible: false,
      }),
    ).toEqual([{ kind: "full" }]);
  });

  it("omits hidden magnetic objects from scoped fetches", () => {
    const state: MeshEntityViewStateMap = {
      "part:free": {
        visible: false,
        renderMode: "surface",
        opacity: 100,
        colorField: "orientation",
      },
    };
    expect(
      deriveFemVectorScopes({
        meshParts: [part({})],
        meshEntityViewState: state,
        airMeshVisible: false,
      }),
    ).toEqual([{ kind: "full" }]);
  });
});

describe("buildDenseFemVectorField", () => {
  it("expands an object-scoped vector payload into dense node storage and mask", () => {
    const result = buildDenseFemVectorField({
      nNodes: 4,
      meshParts: [part({ node_start: 1, node_count: 2 })],
      frames: [
        {
          scope: { kind: "object", id: "free" },
          field: {
            quantityId: "m",
            nComp: 3,
            grid: [2, 1, 1],
            pointCount: 2,
            valueCount: 6,
            dtype: "float64",
            values: new Float64Array([1, 0, 0, 0, 1, 0]),
          },
        },
      ],
    });

    expect(Array.from(result?.values ?? [])).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0]);
    expect(result?.activeMask).toEqual([false, true, true, false]);
    expect(result?.grid).toEqual([4, 1, 1]);
  });
});
