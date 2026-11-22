import { describe, expect, it } from "vitest";

import type { SceneResource } from "@/kernel/api/apiTypes";
import { resolvePlanarSectionGeometryFromMeta } from "@/kernel/visualization/planarSectionModel";

import {
  buildAuthoredPlanarSample,
  sceneHasAuthoredMagnetization,
} from "./authoredPlanarSample";
import { PLANAR_OCCUPANCY } from "./planarOccupancy";

function makeBoxSkyrmionScene(overrides: Partial<SceneResource> = {}): SceneResource {
  return {
    revision: 7,
    magnetization_assets: [
      {
        id: "mag-antiskyrmion",
        kind: "preset_texture",
        name: "Antiskyrmion",
        preset_kind: "antiskyrmion",
        preset_version: 2,
        preset_params: {
          radius: 25e-9,
          core_polarity: 1,
          plane: "xy",
        },
        mapping: {
          space: "object",
          projection: "planar_xy",
          clamp_mode: "none",
        },
      },
    ],
    objects: [
      {
        id: "film-1",
        name: "Film",
        role: "magnet",
        visible: true,
        magnetization_ref: "mag-antiskyrmion",
        geometry: {
          geometry_kind: "box",
          geometry_params: {
            size: [100e-9, 100e-9, 20e-9],
          },
        },
        transform: {
          translation: [0, 0, 10e-9],
        },
      },
    ],
    ...overrides,
  } as SceneResource;
}

describe("sceneHasAuthoredMagnetization", () => {
  it("returns false for null, empty, field-file, non-magnetic, or hidden objects", () => {
    expect(sceneHasAuthoredMagnetization(null)).toBe(false);
    expect(sceneHasAuthoredMagnetization(undefined)).toBe(false);
    expect(sceneHasAuthoredMagnetization({ objects: [] })).toBe(false);

    const fieldFileScene = {
      magnetization_assets: [
        { id: "ff-1", kind: "field_file", name: "Imported" },
      ],
      objects: [
        { id: "obj-1", role: "magnet", visible: true, magnetization_ref: "ff-1" },
      ],
    } as SceneResource;
    expect(sceneHasAuthoredMagnetization(fieldFileScene)).toBe(false);

    const hiddenScene = makeBoxSkyrmionScene({
      objects: [
        {
          id: "film-1",
          role: "magnet",
          visible: false,
          magnetization_ref: "mag-antiskyrmion",
        },
      ],
    });
    expect(sceneHasAuthoredMagnetization(hiddenScene)).toBe(false);

    const antennaScene = makeBoxSkyrmionScene({
      objects: [
        {
          id: "ant-1",
          role: "antenna",
          visible: true,
          magnetization_ref: "mag-antiskyrmion",
        },
      ],
    });
    expect(sceneHasAuthoredMagnetization(antennaScene)).toBe(false);
  });

  it("returns true for object-level preset assets and enabled region texture overrides", () => {
    expect(sceneHasAuthoredMagnetization(makeBoxSkyrmionScene())).toBe(true);

    const regionOverrideScene = {
      magnetization_assets: [],
      objects: [
        {
          id: "film-1",
          role: "magnet",
          visible: true,
          regions: [
            {
              region_id: "core",
              enabled: true,
              shape: { kind: "box", center: [0, 0, 0], size: [20e-9, 20e-9, 10e-9] },
              texture_override: {
                initial_magnetization: {
                  kind: "preset_texture",
                  preset_kind: "uniform",
                  preset_params: { direction: [0, 0, 1] },
                },
              },
            },
          ],
        },
      ],
    } as unknown as SceneResource;
    expect(sceneHasAuthoredMagnetization(regionOverrideScene)).toBe(true);
  });
});

describe("buildAuthoredPlanarSample", () => {
  it("evaluates an antiskyrmion XY slice with valid metadata, section geometry, and unit spins", () => {
    const scene = makeBoxSkyrmionScene();
    const sample = buildAuthoredPlanarSample({
      scene,
      plane: "xy",
      positionFraction: 0.5,
      resolution: [64, 64],
      component: "z",
    });

    expect(sample).not.toBeNull();
    expect(sample!.meta.field_source).toBe("authored_initial_state");
    expect(sample!.meta.canonical_unit).toBe("1");
    expect(sample!.meta.quantity_id).toBe("m");
    expect(sample!.meta.resolution).toEqual([64, 64]);
    expect(sample!.meta.etag).toMatch(/^authored-m:7:/);
    expect(sample!.meta.mesh_overlay_descriptor).toEqual({
      available: false,
      boundary_classification: "none",
      codec: null,
      geometry_source: "none",
    });

    // Box is 100nm x 100nm x 20nm centered at z = 10nm -> z in [0, 20nm], mid = 10nm
    expect(sample!.frame.origin).toEqual([0, 0, 10e-9]);
    expect(sample!.meta.frame.full_bounds_uv_m).toEqual([-50e-9, 50e-9, -50e-9, 50e-9]);
    expect(sample!.meta.frame.bounds_uv_m).toEqual([-50e-9, 50e-9, -50e-9, 50e-9]);

    // Section metadata works natively with resolvePlanarSectionGeometryFromMeta
    const geometry = resolvePlanarSectionGeometryFromMeta(sample!.meta.section, "xy");
    expect(geometry).not.toBeNull();
    expect(geometry!.normal).toBe("z");
    expect(geometry!.normalMin).toBeCloseTo(0, 15);
    expect(geometry!.normalMax).toBeCloseTo(20e-9, 15);

    // Every pixel inside the box is occupied (PLANAR_OCCUPANCY.occupied === 0)
    expect(sample!.meta.occupancy.occupied).toBe(64 * 64);
    expect(sample!.meta.occupancy.empty).toBe(0);

    // Center pixel has mz ≈ +1 (core polarity +1); corner pixel has mz < 0 (background -1)
    const centerIdx = 32 * 64 + 32;
    expect(sample!.mask[centerIdx]).toBe(PLANAR_OCCUPANCY.occupied);
    expect(sample!.scalar[centerIdx]).toBeGreaterThan(0.9);
    const cornerIdx = 0;
    expect(sample!.scalar[cornerIdx]).toBeLessThan(-0.5);
  });

  it("masks pixels outside a cylinder and CSG cylinder-cylinder-difference ring", () => {
    const ringScene = {
      revision: 3,
      magnetization_assets: [
        {
          id: "mag-uniform",
          kind: "preset_texture",
          name: "Uniform X",
          preset_kind: "uniform",
          preset_version: 2,
          preset_params: { direction: [1, 0, 0] },
        },
      ],
      objects: [
        {
          id: "ring-1",
          role: "magnet",
          visible: true,
          magnetization_ref: "mag-uniform",
          geometry: {
            geometry_kind: "difference",
            geometry_params: {
              base: {
                geometry_kind: "cylinder",
                geometry_params: { radius: 60e-9, height: 20e-9, axis: [0, 0, 1] },
              },
              tool: {
                geometry_kind: "cylinder",
                geometry_params: { radius: 25e-9, height: 24e-9, axis: [0, 0, 1] },
              },
            },
          },
        },
      ],
    } as unknown as SceneResource;

    const sample = buildAuthoredPlanarSample({
      scene: ringScene,
      plane: "xy",
      positionFraction: 0.5,
      resolution: [48, 48],
      component: "x",
    });

    expect(sample).not.toBeNull();
    expect(sample!.meta.frame.full_bounds_uv_m).toEqual([-60e-9, 60e-9, -60e-9, 60e-9]);
    const [nx, ny] = sample!.meta.resolution as [number, number];

    // Center (0, 0) is inside the hole -> empty & zeroed vector
    const centerIdx = Math.floor(ny / 2) * nx + Math.floor(nx / 2);
    expect(sample!.mask[centerIdx]).toBe(PLANAR_OCCUPANCY.empty);
    expect(sample!.worldVectors[centerIdx * 3]).toBe(0);

    // Outer corner (-60nm, -60nm) is outside the outer cylinder -> empty
    expect(sample!.mask[0]).toBe(PLANAR_OCCUPANCY.empty);

    // Point on the ring annulus at x ≈ +42nm, y ≈ 0 -> occupied with mx ≈ 1
    const annulusCol = Math.floor(((42e-9 - (-60e-9)) / 120e-9) * nx);
    const annulusRow = Math.floor(ny / 2);
    const annulusIdx = annulusRow * nx + annulusCol;
    expect(sample!.mask[annulusIdx]).toBe(PLANAR_OCCUPANCY.occupied);
    expect(sample!.worldVectors[annulusIdx * 3]).toBeCloseTo(1, 5);
    expect(sample!.scalar[annulusIdx]).toBeCloseTo(1, 5);
  });

  it("supports XZ and YZ planes, crop windows, object viewScope, and all vector components", () => {
    const scene = makeBoxSkyrmionScene({
      magnetization_assets: [
        {
          id: "mag-tilted",
          kind: "preset_texture",
          name: "Tilted",
          preset_kind: "uniform",
          preset_version: 2,
          preset_params: { direction: [0.6, 0.8, 0] },
        },
      ],
      objects: [
        {
          id: "film-1",
          role: "magnet",
          visible: true,
          magnetization_ref: "mag-tilted",
          geometry: {
            geometry_kind: "box",
            geometry_params: { size: [200e-9, 100e-9, 40e-9] },
          },
        },
      ],
    });

    // XZ plane: u = x, v = z, normal = y
    const xzSample = buildAuthoredPlanarSample({
      scene,
      plane: "xz",
      positionFraction: 0.75,
      crop: { u_min_m: -50e-9, u_max_m: 50e-9, v_min_m: -10e-9, v_max_m: 10e-9 },
      viewScope: { kind: "object", scope_id: "film-1" },
      component: "normal",
    });
    expect(xzSample).not.toBeNull();
    // y in [-50nm, 50nm], 0.75 -> +25nm
    expect(xzSample!.frame.origin).toEqual([0, 25e-9, 0]);
    expect(xzSample!.meta.frame.bounds_uv_m).toEqual([-50e-9, 50e-9, -10e-9, 10e-9]);
    expect(xzSample!.meta.frame.full_bounds_uv_m).toEqual([-100e-9, 100e-9, -20e-9, 20e-9]);
    // For XZ plane, normal is +y -> m·n = my = 0.8
    expect(xzSample!.scalar[0]).toBeCloseTo(0.8, 4);

    // YZ plane: u = y (0.8), v = z (0), normal = x (0.6) -> in_plane_magnitude = 0.8
    const yzSample = buildAuthoredPlanarSample({
      scene,
      plane: "yz",
      positionFraction: 0.5,
      component: "in_plane_magnitude",
    });
    expect(yzSample).not.toBeNull();
    expect(yzSample!.scalar[0]).toBeCloseTo(0.8, 4);

    // Orientation component on XY plane: atan2(0.8, 0.6)
    const orientationSample = buildAuthoredPlanarSample({
      scene,
      plane: "xy",
      positionFraction: 0.5,
      component: "orientation",
    });
    expect(orientationSample).not.toBeNull();
    expect(orientationSample!.scalar[0]).toBeCloseTo(Math.atan2(0.8, 0.6), 4);

    // Airbox scope returns null (magnetization is not in the airbox)
    expect(
      buildAuthoredPlanarSample({
        scene,
        plane: "xy",
        positionFraction: 0.5,
        viewScope: { kind: "airbox" },
      }),
    ).toBeNull();
  });

  it("applies enabled region texture overrides on top of the object asset", () => {
    const scene = {
      revision: 4,
      magnetization_assets: [
        {
          id: "mag-bg",
          kind: "preset_texture",
          name: "Down",
          preset_kind: "uniform",
          preset_version: 2,
          preset_params: { direction: [0, 0, -1] },
        },
      ],
      objects: [
        {
          id: "film-1",
          role: "magnet",
          visible: true,
          magnetization_ref: "mag-bg",
          geometry: {
            geometry_kind: "box",
            geometry_params: { size: [100e-9, 100e-9, 10e-9] },
          },
          regions: [
            {
              region_id: "center-up",
              enabled: true,
              priority: 10,
              frame: "object",
              shape: { kind: "box", center: [0, 0, 0], size: [30e-9, 30e-9, 10e-9] },
              texture_override: {
                initial_magnetization: {
                  kind: "preset_texture",
                  preset_kind: "uniform",
                  preset_params: { direction: [0, 0, 1] },
                },
              },
            },
          ],
        },
      ],
    } as unknown as SceneResource;

    const sample = buildAuthoredPlanarSample({
      scene,
      plane: "xy",
      positionFraction: 0.5,
      resolution: [40, 40],
      component: "z",
    });

    expect(sample).not.toBeNull();
    const centerIdx = 20 * 40 + 20;
    expect(sample!.scalar[centerIdx]).toBeCloseTo(1, 5);
    expect(sample!.scalar[0]).toBeCloseTo(-1, 5);
  });
});
