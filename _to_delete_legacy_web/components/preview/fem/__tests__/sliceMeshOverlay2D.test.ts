import { describe, expect, it } from "vitest";

import type { FieldSliceMeta } from "@/src/api/types";
import type { Slice2DToolbarState } from "@/src/features/slice2d";
import type { FemMeshPart } from "../../../../lib/session/types";
import type { FemMeshData } from "../femMeshTypes";
import {
  SLICE_MESH_OVERLAY_HARD_SEGMENT_CAP,
  capSliceMeshOverlay2D,
  buildExactSliceMeshOverlay2D,
} from "../sliceMeshOverlay2D";

function makeToolbar(): Slice2DToolbarState {
  return {
    quantityId: "m",
    component: "magnitude",
    axis: "z",
    mode: "single",
    layerIndex: 0,
    positionPercent: 50,
    positionWorld: null,
    normalAxisBounds: null,
    magneticExtent: null,
    thicknessPercent: null,
    colormap: "viridis",
    autoContrast: true,
    showPrimitives: true,
    showMesh: true,
    showMagneticTexture: true,
    showAirbox: false,
    airboxRenderMode: "wireframe",
    showAirboxVectors: false,
    showQuantity: true,
    showVectors: false,
    vectorDensity: 4,
    renderMode: "mesh-overlay",
    projectionReduction: "mean_occupied",
    projectionIncludeAirAsZero: false,
    projectionSamples: 20,
    projectionResolution: 128,
  };
}

function makeSliceMeta(overrides: Partial<FieldSliceMeta> = {}): FieldSliceMeta {
  return {
    quantity_id: "m",
    plane: "xy",
    component: "magnitude",
    cut_kind: "world",
    cut_norm: 0.25,
    cut_world: 0.25,
    field_revision: 1,
    domain_generation_id: 7,
    sampling_method: "exact",
    etag: "slice-etag",
    slice_revision: "slice-rev",
    x_pixels: 64,
    y_pixels: 64,
    grid: {
      x_size: 64,
      y_size: 64,
      point_count: 64 * 64,
    },
    bounds: {
      u_min: 0,
      u_max: 1,
      v_min: 0,
      v_max: 1,
    },
    scalar: {
      available: true,
      n_comp: 1,
      point_count: 64 * 64,
      min: 0,
      max: 1,
      etag: "scalar-etag",
      href: "/scalar",
    },
    arrows: {
      available: false,
      n_comp: 2,
      point_count: 0,
      min: null,
      max: null,
      etag: null,
      href: null,
    },
    ...overrides,
  };
}

function makeMeshData(): FemMeshData {
  return {
    nodes: [
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ],
    elements: [0, 1, 2, 3],
    boundaryFaces: [],
    nNodes: 4,
    nElements: 1,
    fieldNComp: 3,
    quantityDomain: "magnetic_only",
  };
}

describe("buildExactSliceMeshOverlay2D", () => {
  it("caps very large 2D mesh overlays before rendering", () => {
    const overlay = capSliceMeshOverlay2D({
      topologyKey: "mesh",
      segments: Array.from({ length: SLICE_MESH_OVERLAY_HARD_SEGMENT_CAP + 10 }, (_, index) => ({
        a: [index, index],
        b: [index + 1, index + 1],
      })),
    });

    expect(overlay.segments).toHaveLength(SLICE_MESH_OVERLAY_HARD_SEGMENT_CAP);
    expect(overlay.topologyKey).toContain(":sampled:");
  });

  it("builds exact FEM slice segments from backend slice metadata", () => {
    const overlay = buildExactSliceMeshOverlay2D({
      meshData: makeMeshData(),
      meta: makeSliceMeta(),
      toolbar: makeToolbar(),
      meshParts: [],
      meshEntityViewState: {},
      airSegmentVisible: true,
      objectViewMode: "context",
      visibleObjectIds: [],
    });

    expect(overlay).not.toBeNull();
    expect(overlay?.segments).toHaveLength(3);
    expect(overlay?.segments.every((segment) =>
      segment.a.every(Number.isFinite) && segment.b.every(Number.isFinite),
    )).toBe(true);
  });

  it("falls back to toolbar world position when the backend meta does not expose cut_world", () => {
    const toolbar = makeToolbar();
    toolbar.positionWorld = 0.25;
    const overlay = buildExactSliceMeshOverlay2D({
      meshData: makeMeshData(),
      meta: makeSliceMeta({ cut_kind: "normalized", cut_world: null }),
      toolbar,
      meshParts: [],
      meshEntityViewState: {},
      airSegmentVisible: true,
      objectViewMode: "context",
      visibleObjectIds: [],
    });

    expect(overlay?.segments).toHaveLength(3);
  });

  it("honours airbox visibility through the shared slice visibility model", () => {
    const meshData: FemMeshData = {
      nodes: [
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
        2, 0, 0,
        3, 0, 0,
        2, 1, 0,
        2, 0, 1,
      ],
      elements: [0, 1, 2, 3, 4, 5, 6, 7],
      boundaryFaces: [],
      nNodes: 8,
      nElements: 2,
      quantityDomain: "full_domain",
    };
    const basePart = {
      label: "",
      object_id: null,
      geometry_id: null,
      material_id: null,
      boundary_face_start: 0,
      boundary_face_count: 0,
      boundary_face_indices: [],
      node_start: 0,
      node_count: 0,
      node_indices: [],
      surface_faces: [],
      bounds_min: null,
      bounds_max: null,
    } satisfies Omit<FemMeshPart, "id" | "role" | "element_start" | "element_count">;
    const meshParts: FemMeshPart[] = [
      {
        ...basePart,
        id: "mag",
        label: "magnetic",
        role: "magnetic_object",
        object_id: "body",
        element_start: 0,
        element_count: 1,
      },
      {
        ...basePart,
        id: "air",
        label: "airbox",
        role: "air",
        element_start: 1,
        element_count: 1,
      },
    ];

    const visibleOverlay = buildExactSliceMeshOverlay2D({
      meshData,
      meta: makeSliceMeta(),
      toolbar: makeToolbar(),
      meshParts,
      meshEntityViewState: {
        air: { visible: true, renderMode: "wireframe", opacity: 28, colorField: "none" },
      },
      airSegmentVisible: true,
      objectViewMode: "context",
      visibleObjectIds: ["body"],
    });
    const hiddenOverlay = buildExactSliceMeshOverlay2D({
      meshData,
      meta: makeSliceMeta(),
      toolbar: makeToolbar(),
      meshParts,
      meshEntityViewState: {
        air: { visible: true, renderMode: "wireframe", opacity: 28, colorField: "none" },
      },
      airSegmentVisible: false,
      objectViewMode: "context",
      visibleObjectIds: ["body"],
    });

    expect(visibleOverlay?.segments.length).toBeGreaterThan(hiddenOverlay?.segments.length ?? 0);
  });

  it("can build an airbox-only wireframe overlay from exact FEM topology", () => {
    const meshData: FemMeshData = {
      nodes: [
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
        2, 0, 0,
        3, 0, 0,
        2, 1, 0,
        2, 0, 1,
      ],
      elements: [0, 1, 2, 3, 4, 5, 6, 7],
      boundaryFaces: [],
      nNodes: 8,
      nElements: 2,
      quantityDomain: "full_domain",
    };
    const basePart = {
      label: "",
      object_id: null,
      geometry_id: null,
      material_id: null,
      boundary_face_start: 0,
      boundary_face_count: 0,
      boundary_face_indices: [],
      node_start: 0,
      node_count: 0,
      node_indices: [],
      surface_faces: [],
      bounds_min: null,
      bounds_max: null,
    } satisfies Omit<FemMeshPart, "id" | "role" | "element_start" | "element_count">;
    const meshParts: FemMeshPart[] = [
      {
        ...basePart,
        id: "mag",
        label: "magnetic",
        role: "magnetic_object",
        object_id: "body",
        element_start: 0,
        element_count: 1,
      },
      {
        ...basePart,
        id: "air",
        label: "airbox",
        role: "air",
        element_start: 1,
        element_count: 1,
      },
    ];

    const overlay = buildExactSliceMeshOverlay2D({
      meshData,
      meta: makeSliceMeta(),
      toolbar: makeToolbar(),
      meshParts,
      meshEntityViewState: {
        air: { visible: true, renderMode: "wireframe", opacity: 28, colorField: "none" },
      },
      airSegmentVisible: true,
      objectViewMode: "context",
      visibleObjectIds: ["body"],
      partRoleFilter: new Set(["air", "outer_boundary"]),
    });

    expect(overlay?.segments.length).toBeGreaterThan(0);
    expect(overlay?.segments.every((segment) => segment.partId === "air")).toBe(true);
  });
});
