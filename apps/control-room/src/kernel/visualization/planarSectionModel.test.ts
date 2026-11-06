import { describe, expect, it } from "vitest";

import type {
  DomainMetaResource,
  PlanarFieldMetaResource,
} from "@/kernel/api/apiTypes";

import {
  fractionFromLayerIndex,
  fullThicknessSlabOperator,
  isFullThicknessOperator,
  layerIndexFromFraction,
  nativePlanarResolution,
  planarGridResolutionPresets,
  resolvePlanarSectionGeometry,
  resolvePlanarSectionGeometryFromMeta,
  resolvedSectionCoordinate,
  sectionReduction,
  sectionLayerCount,
} from "./planarSectionModel";

function fdmDomain(): DomainMetaResource {
  return {
    bounds: { min: [0, 0, 0], max: [512e-9, 256e-9, 4e-9] },
    discretization: "fdm",
    grid: { origin: [0, 0, 0], shape: [128, 64, 4], spacing: [4e-9, 4e-9, 1e-9] },
  } as unknown as DomainMetaResource;
}

function femDomain(): DomainMetaResource {
  return {
    bounds: { min: [0, 0, -1e-9], max: [100e-9, 50e-9, 1e-9] },
    discretization: "fem",
    grid: null,
  } as unknown as DomainMetaResource;
}

describe("planarSectionModel", () => {
  it("maps plane axes and native FDM resolution", () => {
    const xz = resolvePlanarSectionGeometry(fdmDomain(), "xz");
    expect(xz).toMatchObject({ normal: "y", u: "x", v: "z", layerCount: 64 });
    expect(xz?.nativeResolution).toEqual([128, 4]);
    expect(nativePlanarResolution(xz)).toEqual([128, 16]);
    expect(resolvePlanarSectionGeometry(femDomain(), "xy")?.layerCount).toBeNull();
  });

  it("round-trips layer indices through the backend snap rule", () => {
    for (const count of [1, 2, 4, 7, 64]) {
      for (let index = 0; index < count; index += 1) {
        expect(layerIndexFromFraction(fractionFromLayerIndex(index, count), count)).toBe(index);
      }
    }
    expect(layerIndexFromFraction(0, 4)).toBe(0);
    expect(layerIndexFromFraction(0.5, 4)).toBe(1);
    expect(layerIndexFromFraction(1, 4)).toBe(3);
  });

  it("reports the snapped FDM coordinate and the continuous FEM coordinate", () => {
    const fdm = resolvePlanarSectionGeometry(fdmDomain(), "xy")!;
    expect(resolvedSectionCoordinate(fdm, 0.5)).toBeCloseTo(1.5e-9, 18);
    const fem = resolvePlanarSectionGeometry(femDomain(), "xy")!;
    expect(resolvedSectionCoordinate(fem, 0.25)).toBeCloseTo(-0.5e-9, 18);
  });

  it("detects the full-thickness average slab", () => {
    const geometry = resolvePlanarSectionGeometry(fdmDomain(), "xy")!;
    const slab = fullThicknessSlabOperator(geometry);
    expect(slab.thickness_m).toBeCloseTo(8e-9, 18);
    expect(isFullThicknessOperator(slab, geometry)).toBe(true);
    expect(sectionReduction(slab, geometry)).toBe("average");
    expect(sectionReduction({ kind: "slab_average", thickness_m: 1e-9 }, geometry)).toBe("single");
    expect(sectionReduction({ kind: "plane_sample" }, geometry)).toBe("single");
  });

  it("lists native-grid presets inside the query limits", () => {
    const xy = resolvePlanarSectionGeometry(fdmDomain(), "xy");
    expect(planarGridResolutionPresets(xy).map(({ width, height }) => [width, height])).toEqual([
      [128, 64],
      [64, 32],
      [32, 16],
      [16, 16],
    ]);
    expect(planarGridResolutionPresets(resolvePlanarSectionGeometry(femDomain(), "xy"))).toEqual([]);
  });
});

describe("base planar section metadata", () => {
  const airboxSection = {
    cut_element_count: null,
    layer_count: 26,
    layer_index: 12,
    layer_spacing_m: 2.5e-9,
    layer_stops_m: [],
    navigation_step_kind: "fdm_cell",
    navigation_step_m: 2.5e-9,
    normal_axis: "z",
    normal_max_m: 60e-9,
    normal_min_m: -5e-9,
    plane: "xy",
    requested_coordinate_m: 27.5e-9,
    requested_fraction: 0.5,
    resolved_coordinate_m: 26.25e-9,
    stops_kind: "fdm_cell_layers",
  } as NonNullable<PlanarFieldMetaResource["section"]>;

  it("uses the Airbox section's 26 FDM centers and never the magnetic grid", () => {
    const magneticDomain = {
      bounds: { min: [0, 0, 10e-9], max: [100e-9, 100e-9, 40e-9] },
      discretization: "fdm",
      grid: {
        origin: [0, 0, 10e-9],
        shape: [40, 40, 12],
        spacing: [2.5e-9, 2.5e-9, 2.5e-9],
      },
    } as unknown as DomainMetaResource;
    const magneticGeometry = resolvePlanarSectionGeometry(magneticDomain, "xy")!;
    const airboxGeometry = resolvePlanarSectionGeometryFromMeta(airboxSection, "xy")!;

    expect(magneticGeometry).toMatchObject({
      normalMin: 10e-9,
      normalMax: 40e-9,
      layerCount: 12,
    });
    expect(airboxGeometry).toMatchObject({
      normalMin: -5e-9,
      normalMax: 60e-9,
      layerCount: 26,
      layerSpacing: 2.5e-9,
      nativeResolution: null,
    });
    expect(sectionLayerCount(airboxGeometry)).toBe(26);
    for (let index = 0; index < 26; index += 1) {
      const fraction = fractionFromLayerIndex(index, 26);
      expect(resolvedSectionCoordinate(airboxGeometry, fraction)).toBeCloseTo(
        -5e-9 + (index + 0.5) * 2.5e-9,
        20,
      );
    }
    expect(resolvedSectionCoordinate(airboxGeometry, 0.5)).toBeCloseTo(26.25e-9, 20);
  });

  it("preserves FEM stops and reports unavailable or mismatched section geometry", () => {
    const fem = resolvePlanarSectionGeometryFromMeta({
      ...airboxSection,
      layer_count: null,
      layer_index: null,
      layer_spacing_m: null,
      layer_stops_m: [-5e-9, 2e-9, 10e-9, 35e-9, 60e-9],
      navigation_step_kind: "median_element_height",
      navigation_step_m: 8e-9,
      stops_kind: "fem_node_planes",
    }, "xy");
    expect(fem?.stops).toEqual([-5e-9, 2e-9, 10e-9, 35e-9, 60e-9]);
    expect(fem?.normalMin).toBe(-5e-9);
    expect(fem?.normalMax).toBe(60e-9);

    expect(resolvePlanarSectionGeometryFromMeta(null, "xy")).toBeNull();
    expect(resolvePlanarSectionGeometryFromMeta(airboxSection, "xz")).toBeNull();
    expect(resolvePlanarSectionGeometryFromMeta({
      ...airboxSection,
      layer_spacing_m: null,
    }, "xy")).toBeNull();
    expect(resolvePlanarSectionGeometryFromMeta({
      ...airboxSection,
      normal_max_m: -5e-9,
    }, "xy")).toBeNull();
  });
});

describe("section layer stepping", () => {
  it("steps FDM layers by index and clamps at the domain edges", async () => {
    const { stepSectionFraction } = await import("./planarSectionModel");
    const geometry = {
      layerCount: 8,
      layerSpacing: 7.5e-9,
      nativeResolution: [64, 32] as const,
      normal: "z" as const,
      normalExtent: 60e-9,
      normalMax: 60e-9,
      normalMin: 0,
      plane: "xy" as const,
      u: "x" as const,
      v: "y" as const,
    };
    expect(stepSectionFraction((3 + 0.5) / 8, geometry, 1)).toBeCloseTo((4 + 0.5) / 8);
    expect(stepSectionFraction((7 + 0.5) / 8, geometry, 10)).toBeCloseTo((7 + 0.5) / 8);
    expect(stepSectionFraction(0.5 / 8, geometry, -1)).toBeCloseTo(0.5 / 8);
  });

  it("moves continuous sections by one percent of the extent", async () => {
    const { stepSectionFraction } = await import("./planarSectionModel");
    expect(stepSectionFraction(0.5, null, 1)).toBeCloseTo(0.51);
    expect(stepSectionFraction(0.995, null, 1)).toBe(1);
  });
});

describe("FEM node-plane stops", () => {
  it("maps swept-mesh node planes to discrete layers and back", async () => {
    const {
      sectionLayerCount,
      sectionLayerFraction,
      sectionLayerIndex,
      stepSectionFraction,
      withSectionStops,
    } = await import("./planarSectionModel");
    const continuous = {
      layerCount: null,
      layerSpacing: null,
      nativeResolution: null,
      normal: "z" as const,
      normalExtent: 20e-9,
      normalMax: 20e-9,
      normalMin: 0,
      plane: "xy" as const,
      u: "x" as const,
      v: "y" as const,
    };
    const geometry = withSectionStops(continuous, {
      layer_stops_m: [0, 5e-9, 10e-9, 15e-9, 20e-9],
      plane: "xy",
    })!;
    expect(sectionLayerCount(geometry)).toBe(5);
    expect(sectionLayerIndex(geometry, 0.48)).toBe(2);
    expect(sectionLayerFraction(geometry, 3)).toBeCloseTo(0.75);
    expect(stepSectionFraction(0.5, geometry, 1)).toBeCloseTo(0.75);
    // Stops of another plane are ignored.
    expect(withSectionStops(continuous, { layer_stops_m: [0, 1], plane: "xz" })?.stops).toBeUndefined();
  });

  it("keeps a request between node planes and steps to the adjacent plane", async () => {
    const {
      resolvedSectionCoordinate,
      sectionStopPosition,
      stepSectionFraction,
      withSectionStops,
    } = await import("./planarSectionModel");
    // Three exact layers in a 9 nm film inside an 80 nm domain.
    const geometry = withSectionStops({
      layerCount: null,
      layerSpacing: null,
      nativeResolution: null,
      normal: "z" as const,
      normalExtent: 80e-9,
      normalMax: 40e-9,
      normalMin: -40e-9,
      plane: "xy" as const,
      u: "x" as const,
      v: "y" as const,
    }, {
      layer_stops_m: [-4.5e-9, -1.5e-9, 1.5e-9, 4.5e-9],
      plane: "xy",
    })!;
    const fractionOf = (z: number) => (z + 40e-9) / 80e-9;
    expect(sectionStopPosition(geometry, 0.5).onStop).toBe(false);
    expect(resolvedSectionCoordinate(geometry, 0.5)).toBeCloseTo(0, 18);
    expect(sectionStopPosition(geometry, fractionOf(1.5e-9)).onStop).toBe(true);
    expect(resolvedSectionCoordinate(geometry, fractionOf(1.5e-9))).toBeCloseTo(1.5e-9, 18);
    expect(stepSectionFraction(0.5, geometry, 1)).toBeCloseTo(fractionOf(1.5e-9), 12);
    expect(stepSectionFraction(0.5, geometry, -1)).toBeCloseTo(fractionOf(-1.5e-9), 12);
    expect(stepSectionFraction(0.5, geometry, 2)).toBeCloseTo(fractionOf(4.5e-9), 12);
    // Above the top plane there is no further stop in that direction.
    expect(stepSectionFraction(fractionOf(20e-9), geometry, 1)).toBeCloseTo(fractionOf(20e-9), 12);
  });
});

describe("continuous FEM navigation step", () => {
  it("steps by the published median element height and ignores other step kinds", async () => {
    const { stepSectionFraction, withSectionStops } = await import("./planarSectionModel");
    const continuous = {
      layerCount: null,
      layerSpacing: null,
      nativeResolution: null,
      normal: "z" as const,
      normalExtent: 80e-9,
      normalMax: 40e-9,
      normalMin: -40e-9,
      plane: "xy" as const,
      u: "x" as const,
      v: "y" as const,
    };
    const geometry = withSectionStops(continuous, {
      navigation_step_kind: "median_element_height",
      navigation_step_m: 4e-9,
      plane: "xy",
    })!;
    expect(geometry.navigationStepM).toBe(4e-9);
    expect(stepSectionFraction(0.5, geometry, 1)).toBeCloseTo(0.55, 12);
    expect(stepSectionFraction(0.5, geometry, -2)).toBeCloseTo(0.4, 12);
    const fallback = withSectionStops(continuous, {
      navigation_step_kind: "extent_fraction",
      navigation_step_m: 0.8e-9,
      plane: "xy",
    })!;
    expect(fallback.navigationStepM).toBeUndefined();
    expect(stepSectionFraction(0.5, fallback, 1)).toBeCloseTo(0.51, 12);
  });
});

describe("named object layers", () => {
  it("merges realized bodies per object and maps a layer to a centred slab", async () => {
    const { matchObjectLayer, objectLayerSlice, objectSectionLayers } = await import("./planarSectionModel");
    const layers = objectSectionLayers([
      { bounds_max: [1, 1, 5e-9], bounds_min: [0, 0, 0], object_id: "free", object_name: "free_layer" },
      { bounds_max: [1, 1, 12e-9], bounds_min: [0, 0, 7e-9], object_id: "ref", object_name: "reference" },
      { bounds_max: [2, 1, 6e-9], bounds_min: [1, 0, 1e-9], object_id: "free", object_name: "free_layer" },
      { bounds_max: [1, 1, 3e-9], bounds_min: [0, 0, 3e-9], object_id: "flat", object_name: "flat" },
    ], "z");
    expect(layers).toEqual([
      { max: 6e-9, min: 0, name: "free_layer", objectId: "free" },
      { max: 12e-9, min: 7e-9, name: "reference", objectId: "ref" },
    ]);
    const geometry = {
      layerCount: null,
      layerSpacing: null,
      nativeResolution: null,
      normal: "z" as const,
      normalExtent: 20e-9,
      normalMax: 20e-9,
      normalMin: 0,
      plane: "xy" as const,
      u: "x" as const,
      v: "y" as const,
    };
    const slice = objectLayerSlice(geometry, layers[1]!);
    expect(slice.operator).toEqual({ kind: "slab_average", thickness_m: 5e-9 });
    expect(slice.position_fraction).toBeCloseTo(0.475, 12);
    expect(matchObjectLayer(slice, geometry, layers)?.objectId).toBe("ref");
    expect(matchObjectLayer({ ...slice, operator: { kind: "plane_sample" } }, geometry, layers)).toBeNull();
  });
});
