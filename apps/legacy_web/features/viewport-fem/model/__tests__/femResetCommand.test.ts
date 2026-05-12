/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, expect, it } from "vitest";

import type { FemMeshPart } from "@/lib/session/types";
import {
  buildViewportDisplayReset,
  VIEWPORT_DISPLAY_DEFAULTS,
  visualizationPatchForViewportDisplayDefaults,
} from "../femResetCommand";
import type { ViewportSelectionScope } from "../femViewportSelection";

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

describe("buildViewportDisplayReset", () => {
  const magPart = makePart({ id: "mag-1", role: "magnetic_object" });
  const airPart = makePart({ id: "air-1", role: "air" });
  const meshParts = [magPart, airPart];

  it("universe scope resets all parts and signals resetGlobals", () => {
    const scope: ViewportSelectionScope = { kind: "universe" };
    const currentState = {
      "mag-1": { visible: true, renderMode: "wireframe" as const, opacity: 42, colorField: "x" as const },
      "air-1": { visible: true, renderMode: "surface" as const, opacity: 90, colorField: "none" as const },
    };
    const result = buildViewportDisplayReset(scope, meshParts, currentState, ["mag-1", "air-1"]);

    expect(result.resetGlobals).toBe(true);
    expect(result.globals).toEqual(VIEWPORT_DISPLAY_DEFAULTS);
    // Magnetic part should reset to its role defaults
    expect(result.meshEntityViewState["mag-1"].renderMode).toBe("surface+edges");
    expect(result.meshEntityViewState["mag-1"].opacity).toBe(100);
    // Air part should reset to its role defaults (hidden, wireframe, low opacity)
    expect(result.meshEntityViewState["air-1"].visible).toBe(false);
    expect(result.meshEntityViewState["air-1"].renderMode).toBe("wireframe");
    expect(result.meshEntityViewState["air-1"].opacity).toBe(28);
  });

  it("object scope resets only targeted parts, no global reset", () => {
    const scope: ViewportSelectionScope = { kind: "object", objectId: "obj-1", partIds: ["mag-1"] };
    const currentState = {
      "mag-1": { visible: true, renderMode: "wireframe" as const, opacity: 42, colorField: "x" as const },
      "air-1": { visible: true, renderMode: "surface" as const, opacity: 90, colorField: "none" as const },
    };
    const result = buildViewportDisplayReset(scope, meshParts, currentState, ["mag-1", "air-1"]);

    expect(result.resetGlobals).toBe(false);
    // mag-1 should be reset
    expect(result.meshEntityViewState["mag-1"].renderMode).toBe("surface+edges");
    expect(result.meshEntityViewState["mag-1"].opacity).toBe(100);
    // air-1 should be UNCHANGED
    expect(result.meshEntityViewState["air-1"].renderMode).toBe("surface");
    expect(result.meshEntityViewState["air-1"].opacity).toBe(90);
  });

  it("airbox scope resets only air part", () => {
    const scope: ViewportSelectionScope = { kind: "airbox", partId: "air-1" };
    const currentState = {
      "mag-1": { visible: true, renderMode: "points" as const, opacity: 50, colorField: "z" as const },
      "air-1": { visible: true, renderMode: "surface" as const, opacity: 90, colorField: "none" as const },
    };
    const result = buildViewportDisplayReset(scope, meshParts, currentState, ["mag-1", "air-1"]);

    expect(result.resetGlobals).toBe(false);
    // air-1 should be reset to defaults
    expect(result.meshEntityViewState["air-1"].visible).toBe(false);
    expect(result.meshEntityViewState["air-1"].renderMode).toBe("wireframe");
    // mag-1 should be UNCHANGED
    expect(result.meshEntityViewState["mag-1"].renderMode).toBe("points");
    expect(result.meshEntityViewState["mag-1"].opacity).toBe(50);
  });

  it("part scope resets only specified part", () => {
    const scope: ViewportSelectionScope = { kind: "part", partId: "mag-1" };
    const currentState = {
      "mag-1": { visible: true, renderMode: "wireframe" as const, opacity: 42, colorField: "x" as const },
    };
    const result = buildViewportDisplayReset(scope, meshParts, currentState, ["mag-1"]);

    expect(result.resetGlobals).toBe(false);
    expect(result.meshEntityViewState["mag-1"].renderMode).toBe("surface+edges");
    expect(result.meshEntityViewState["mag-1"].opacity).toBe(100);
  });
});

describe("visualizationPatchForViewportDisplayDefaults", () => {
  it("maps viewport defaults to one canonical visualization state patch", () => {
    expect(visualizationPatchForViewportDisplayDefaults()).toEqual({
      layers: {
        surface: {
          visible: true,
          opacity: 1,
        },
        quantity_overlay: {
          visible: true,
          opacity: 1,
        },
        wireframe: {
          visible: true,
        },
        volume_mesh: {
          visible: false,
        },
        points: {
          visible: false,
        },
        vectors: {
          visible: false,
        },
        primitives: {
          visible: true,
        },
        airbox: {
          visible: VIEWPORT_DISPLAY_DEFAULTS.airMeshVisible,
          opacity: 0.28,
        },
      },
      fem: {
        topology_mode: "boundary",
      },
      clip: {
        enabled: false,
        axis: "x",
        position_percent: 50,
        flipped: false,
      },
    });
  });

  it("normalizes alternate render modes and percentage opacity values", () => {
    const patch = visualizationPatchForViewportDisplayDefaults({
      ...VIEWPORT_DISPLAY_DEFAULTS,
      meshRenderMode: "mesh",
      meshOpacity: 35,
      meshClipEnabled: true,
      meshClipAxis: "z",
      meshClipPos: 80,
      meshShowArrows: true,
      airMeshVisible: false,
      airMeshOpacity: 15,
    });

    expect(patch.layers?.surface?.visible).toBe(false);
    expect(patch.layers?.surface?.opacity).toBe(0.35);
    expect(patch.layers?.quantity_overlay?.opacity).toBe(0.35);
    expect(patch.layers?.wireframe?.visible).toBe(false);
    expect(patch.layers?.volume_mesh?.visible).toBe(true);
    expect(patch.layers?.vectors?.visible).toBe(true);
    expect(patch.layers?.airbox).toEqual({ visible: false, opacity: 0.15 });
    expect(patch.fem?.topology_mode).toBe("volume");
    expect(patch.clip).toEqual({
      enabled: true,
      axis: "z",
      position_percent: 80,
      flipped: false,
    });
  });
});
