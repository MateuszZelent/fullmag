import { describe, expect, it } from "vitest";

import type { FemMeshPart, MeshEntityViewStateMap } from "@/lib/session/types";
import { reduceAirboxDisplayTransaction } from "../airboxDisplayReducer";

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

describe("reduceAirboxDisplayTransaction", () => {
  it("enables airbox vectors as one transaction and records restore state", () => {
    const transaction = reduceAirboxDisplayTransaction({
      patch: { vectors: true },
      airboxParts: [part({})],
      meshEntityViewState: {},
      vectorDomainFilter: "magnetic_only",
      ferromagnetVisibilityMode: "hide",
      vectorRestoreState: null,
    });

    expect(transaction.displayPatch).toMatchObject({
      layers: {
        airbox: {
          visible: true,
          vectors: { visible: true, domain: "airbox_only" },
        },
        vectors: { visible: true, domain: "airbox_only" },
      },
      vector_style: { ferromagnet_visibility: "ghost" },
    });
    expect(transaction.vectorRestoreState).toEqual({
      active: true,
      vectorDomainFilter: "magnetic_only",
      ferromagnetVisibilityMode: "hide",
    });
    expect(transaction.meshEntityViewStateChanged).toBe(false);
  });

  it("disables airbox vectors and restores previous vector domain and ferro visibility", () => {
    const transaction = reduceAirboxDisplayTransaction({
      patch: { vectors: false },
      airboxParts: [part({})],
      meshEntityViewState: {},
      vectorDomainFilter: "airbox_only",
      ferromagnetVisibilityMode: "ghost",
      vectorRestoreState: {
        active: true,
        vectorDomainFilter: "full_domain",
        ferromagnetVisibilityMode: "hide",
      },
    });

    expect(transaction.displayPatch).toMatchObject({
      layers: {
        airbox: {
          vectors: { visible: false, domain: "airbox_only" },
        },
        vectors: { visible: false, domain: "full_domain" },
      },
      vector_style: { ferromagnet_visibility: "hide" },
    });
    expect(transaction.vectorRestoreState).toBeNull();
  });

  it("updates airbox render state for all air-related parts in one mesh-state result", () => {
    const meshEntityViewState: MeshEntityViewStateMap = {
      "part:air": {
        visible: true,
        geometryVisible: true,
        renderMode: "wireframe",
        wireframeScope: "surface",
        pointsScope: "surface",
        vectorsScope: "surface",
        opacity: 28,
        colorField: "none",
      },
    };

    const transaction = reduceAirboxDisplayTransaction({
      patch: {
        shaded: true,
        wireframe: true,
        opacity: 45,
        wireframeScope: "full",
        vectorsScope: "full",
      },
      airboxParts: [part({}), part({ id: "part:outer", role: "outer_boundary" })],
      meshEntityViewState,
      vectorDomainFilter: "auto",
      ferromagnetVisibilityMode: "hide",
      vectorRestoreState: null,
    });

    expect(transaction.meshEntityViewStateChanged).toBe(true);
    expect(transaction.meshEntityViewState["part:air"]).toMatchObject({
      renderMode: "surface+edges",
      opacity: 45,
      wireframeScope: "full",
      vectorsScope: "full",
    });
    expect(transaction.meshEntityViewState["part:outer"]).toMatchObject({
      renderMode: "surface+edges",
      opacity: 45,
      wireframeScope: "full",
      vectorsScope: "full",
    });
    expect(transaction.displayPatch).toMatchObject({
      layers: {
        airbox: {
          opacity: 0.45,
          surface: { visible: true, opacity: 0.45 },
          wireframe: { visible: true },
        },
      },
    });
  });

  it("keeps canonical airbox points independent from shaded and wireframe passes", () => {
    const meshEntityViewState: MeshEntityViewStateMap = {
      "part:air": {
        visible: true,
        geometryVisible: true,
        renderPasses: { surface: true, wireframe: true, points: false },
        renderMode: "surface+edges",
        wireframeScope: "surface",
        pointsScope: "surface",
        vectorsScope: "surface",
        opacity: 28,
        colorField: "none",
      },
    };

    const transaction = reduceAirboxDisplayTransaction({
      patch: { points: true },
      airboxParts: [part({})],
      meshEntityViewState,
      vectorDomainFilter: "auto",
      ferromagnetVisibilityMode: "hide",
      vectorRestoreState: null,
    });

    expect(transaction.displayPatch).toEqual({
      layers: {
        airbox: {
          surface: { visible: true },
          wireframe: { visible: true },
          points: { visible: true },
        },
      },
    });
    expect(transaction.meshEntityViewState["part:air"]).toMatchObject({
      renderPasses: { surface: true, wireframe: true, points: true },
      renderMode: "surface+edges",
    });
  });

  it("keeps airbox points as an independent render pass over shaded and wireframe", () => {
    const transaction = reduceAirboxDisplayTransaction({
      patch: { points: true },
      airboxParts: [part({})],
      meshEntityViewState: {
        "part:air": {
          visible: true,
          geometryVisible: true,
          renderPasses: { surface: true, wireframe: true, points: false },
          renderMode: "surface+edges",
          wireframeScope: "surface",
          pointsScope: "surface",
          vectorsScope: "surface",
          opacity: 28,
          colorField: "none",
        },
      },
      vectorDomainFilter: "auto",
      ferromagnetVisibilityMode: "hide",
      vectorRestoreState: null,
    });

    expect(transaction.meshEntityViewState["part:air"]).toMatchObject({
      renderMode: "surface+edges",
      renderPasses: {
        surface: true,
        wireframe: true,
        points: true,
      },
    });
    expect(transaction.displayPatch).toMatchObject({
      layers: {
        airbox: {
          surface: { visible: true },
          wireframe: { visible: true },
          points: { visible: true },
        },
      },
    });
  });
});
