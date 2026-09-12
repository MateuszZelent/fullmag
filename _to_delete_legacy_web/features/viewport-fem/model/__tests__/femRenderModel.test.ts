/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, expect, it } from "vitest";

import type { FemMeshPart } from "@/lib/session/types";
import { buildVisibleLayers } from "../femRenderModel";

function makePart(partial: Partial<FemMeshPart>): FemMeshPart {
  return {
    id: "part-1",
    label: "Part",
    role: "magnetic_object",
    object_id: "obj-1",
    geometry_id: "geo-1",
    material_id: "mat-1",
    element_start: 0,
    element_count: 1,
    boundary_face_start: 0,
    boundary_face_count: 1,
    boundary_face_indices: [0],
    node_start: 0,
    node_count: 3,
    node_indices: [0, 1, 2],
    surface_faces: [[0, 1, 2]],
    bounds_min: [0, 0, 0],
    bounds_max: [1, 1, 1],
    ...partial,
  };
}

const BASE_INPUT = {
  partRenderDataById: new Map(),
  meshEntityViewState: {},
  objectViewMode: "context" as const,
  vectorDomainFilter: "auto" as const,
  ferromagnetVisibilityMode: "hide" as const,
  selectedObjectId: null,
  selectedEntityId: null,
  focusedEntityId: null,
  airSegmentVisible: true,
};

describe("buildVisibleLayers", () => {
  it("returns empty list for empty mesh", () => {
    expect(
      buildVisibleLayers({ ...BASE_INPUT, meshParts: [] }),
    ).toEqual([]);
  });

  it("marks one visible layer as primary for camera", () => {
    const part = makePart({});
    const layers = buildVisibleLayers({
      ...BASE_INPUT,
      meshParts: [part],
      meshEntityViewState: {
        [part.id]: {
          visible: true,
          renderMode: "surface",
          opacity: 100,
          colorField: "orientation",
        },
      },
    });

    expect(layers).toHaveLength(1);
    expect(layers[0].isPrimaryForCamera).toBe(true);
  });

  // D-01 regression: Composite object with 3 parts — all are selected
  it("selects ALL parts of a composite object", () => {
    const shell = makePart({ id: "shell", object_id: "obj-nf", label: "shell" });
    const core = makePart({ id: "core", object_id: "obj-nf", label: "core" });
    const cap = makePart({ id: "cap", object_id: "obj-nf", label: "cap" });
    const viewState = {
      shell: { visible: true, renderMode: "surface+edges" as const, opacity: 100, colorField: "orientation" as const },
      core: { visible: true, renderMode: "surface+edges" as const, opacity: 100, colorField: "orientation" as const },
      cap: { visible: true, renderMode: "surface+edges" as const, opacity: 100, colorField: "orientation" as const },
    };

    const layers = buildVisibleLayers({
      ...BASE_INPUT,
      meshParts: [shell, core, cap],
      meshEntityViewState: viewState,
      selectedObjectId: "obj-nf",
    });

    expect(layers).toHaveLength(3);
    expect(layers.every((l) => l.isSelected)).toBe(true);
  });

  // D-04 regression: Airbox hidden by default
  it("hides air parts when airSegmentVisible is false", () => {
    const air = makePart({ id: "air-1", role: "air", object_id: "air" });
    const mag = makePart({ id: "mag-1", object_id: "obj-1" });

    const layers = buildVisibleLayers({
      ...BASE_INPUT,
      meshParts: [air, mag],
      meshEntityViewState: {
        "air-1": { visible: false, renderMode: "wireframe", opacity: 28, colorField: "none" },
        "mag-1": { visible: true, renderMode: "surface+edges", opacity: 100, colorField: "orientation" },
      },
      airSegmentVisible: false,
    });

    expect(layers).toHaveLength(1);
    expect(layers[0].part.id).toBe("mag-1");
  });

  // D-04 regression: Airbox does NOT come back after render mode change
  it("keeps air hidden when only magnetic object is selected", () => {
    const air = makePart({ id: "air-1", role: "air", object_id: "air" });
    const mag = makePart({ id: "mag-1", object_id: "obj-1" });

    const layers = buildVisibleLayers({
      ...BASE_INPUT,
      meshParts: [air, mag],
      meshEntityViewState: {
        "air-1": { visible: false, renderMode: "wireframe", opacity: 28, colorField: "none" },
        "mag-1": { visible: true, renderMode: "wireframe", opacity: 100, colorField: "orientation" },
      },
      selectedObjectId: "obj-1",
      airSegmentVisible: false,
    });

    expect(layers).toHaveLength(1);
    expect(layers[0].part.id).toBe("mag-1");
  });

  // Isolate mode: only selected parts visible
  it("shows only selected parts in isolate mode", () => {
    const shell = makePart({ id: "shell", object_id: "obj-nf" });
    const core = makePart({ id: "core", object_id: "obj-nf" });
    const disk = makePart({ id: "disk", object_id: "obj-disk" });
    const viewState = {
      shell: { visible: true, renderMode: "surface" as const, opacity: 100, colorField: "orientation" as const },
      core: { visible: true, renderMode: "surface" as const, opacity: 100, colorField: "orientation" as const },
      disk: { visible: true, renderMode: "surface" as const, opacity: 100, colorField: "orientation" as const },
    };

    const layers = buildVisibleLayers({
      ...BASE_INPUT,
      meshParts: [shell, core, disk],
      meshEntityViewState: viewState,
      objectViewMode: "isolate",
      selectedObjectId: "obj-nf",
    });

    expect(layers).toHaveLength(2);
    expect(layers.map((l) => l.part.id).sort()).toEqual(["core", "shell"]);
  });

  // Vector-domain filters must not hide geometry; they only scope glyph sampling.
  it("keeps magnetic parts visible in airbox_only + hide mode", () => {
    const air = makePart({ id: "air-1", role: "air", object_id: "air" });
    const mag = makePart({ id: "mag-1", object_id: "obj-1" });
    const viewState = {
      "air-1": { visible: true, renderMode: "wireframe" as const, opacity: 28, colorField: "none" as const },
      "mag-1": { visible: true, renderMode: "surface" as const, opacity: 100, colorField: "orientation" as const },
    };

    const layers = buildVisibleLayers({
      ...BASE_INPUT,
      meshParts: [air, mag],
      meshEntityViewState: viewState,
      vectorDomainFilter: "airbox_only",
      ferromagnetVisibilityMode: "hide",
      airSegmentVisible: true,
    });

    expect(layers).toHaveLength(2);
    expect(layers.map((l) => l.part.role).sort()).toEqual(["air", "magnetic_object"]);
  });

  // Vector-domain filters must not ghost texture geometry; they only scope glyph sampling.
  it("keeps magnetic parts fully visible in airbox_only + ghost mode", () => {
    const air = makePart({ id: "air-1", role: "air", object_id: "air" });
    const mag = makePart({ id: "mag-1", object_id: "obj-1" });
    const viewState = {
      "air-1": { visible: true, renderMode: "wireframe" as const, opacity: 28, colorField: "none" as const },
      "mag-1": { visible: true, renderMode: "surface" as const, opacity: 100, colorField: "orientation" as const },
    };

    const layers = buildVisibleLayers({
      ...BASE_INPUT,
      meshParts: [air, mag],
      meshEntityViewState: viewState,
      vectorDomainFilter: "airbox_only",
      ferromagnetVisibilityMode: "ghost",
      airSegmentVisible: true,
    });

    expect(layers).toHaveLength(2);
    const magneticLayer = layers.find((l) => l.part.id === "mag-1");
    expect(magneticLayer).toBeDefined();
    expect(magneticLayer!.viewState.opacity).toBe(100);
    expect(magneticLayer!.viewState.colorField).toBe("orientation");
  });

  it("preserves points mode for ghosted magnetic parts in airbox_only mode", () => {
    const air = makePart({ id: "air-1", role: "air", object_id: "air" });
    const mag = makePart({ id: "mag-1", object_id: "obj-1" });
    const viewState = {
      "air-1": { visible: true, renderMode: "wireframe" as const, opacity: 28, colorField: "none" as const },
      "mag-1": { visible: true, renderMode: "points" as const, opacity: 100, colorField: "orientation" as const },
    };

    const layers = buildVisibleLayers({
      ...BASE_INPUT,
      meshParts: [air, mag],
      meshEntityViewState: viewState,
      vectorDomainFilter: "airbox_only",
      ferromagnetVisibilityMode: "ghost",
      airSegmentVisible: true,
    });

    const ghostLayer = layers.find((layer) => layer.part.id === "mag-1");
    expect(ghostLayer).toBeDefined();
    expect(ghostLayer!.viewState.renderMode).toBe("points");
  });

  it("does not hide magnetic parts in airbox_only when arrows are disabled", () => {
    const air = makePart({ id: "air-1", role: "air", object_id: "air" });
    const mag = makePart({ id: "mag-1", object_id: "obj-1" });
    const viewState = {
      "air-1": { visible: true, renderMode: "wireframe" as const, opacity: 28, colorField: "none" as const },
      "mag-1": { visible: true, renderMode: "surface" as const, opacity: 100, colorField: "orientation" as const },
    };

    const layers = buildVisibleLayers({
      ...BASE_INPUT,
      meshParts: [air, mag],
      meshEntityViewState: viewState,
      vectorDomainFilter: "airbox_only",
      ferromagnetVisibilityMode: "hide",
      airSegmentVisible: true,
      showArrows: false,
    });

    expect(layers).toHaveLength(2);
    expect(layers.map((l) => l.part.role).sort()).toEqual(["air", "magnetic_object"]);
  });
});
