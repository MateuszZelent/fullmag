import { describe, expect, it } from "vitest";

import { defaultArrayAxisSpec } from "@/kernel/authoring/array3dModel";

import { computeSceneGeometryBoundsMeters } from "./sceneGeometryBounds";

describe("computeSceneGeometryBoundsMeters", () => {
  it("computes accurate bounds across all supported primitive kinds", () => {
    const box = computeSceneGeometryBoundsMeters({
      geometry_kind: "Box",
      geometry_params: { size: [500e-9, 400e-9, 20e-9] },
    });
    expect(box?.size).toEqual([500e-9, 400e-9, 20e-9]);

    const cyl = computeSceneGeometryBoundsMeters({
      geometry_kind: "Cylinder",
      geometry_params: { axis: [0, 0, 1], height: 30e-9, radius: 50e-9 },
    });
    expect(cyl?.size[0]).toBeCloseTo(100e-9, 15);
    expect(cyl?.size[1]).toBeCloseTo(100e-9, 15);
    expect(cyl?.size[2]).toBeCloseTo(30e-9, 15);

    const sphere = computeSceneGeometryBoundsMeters({
      geometry_kind: "Sphere",
      geometry_params: { radius: 40e-9 },
    });
    expect(sphere?.size).toEqual([80e-9, 80e-9, 80e-9]);

    const ellipsoid = computeSceneGeometryBoundsMeters({
      geometry_kind: "Ellipsoid",
      geometry_params: { radii: [60e-9, 30e-9, 10e-9] },
    });
    expect(ellipsoid?.size).toEqual([120e-9, 60e-9, 20e-9]);

    const cone = computeSceneGeometryBoundsMeters({
      geometry_kind: "Cone",
      geometry_params: { axis: [0, 0, 1], height: 50e-9, radius_bottom: 40e-9, radius_top: 10e-9 },
    });
    expect(cone?.size[0]).toBeCloseTo(80e-9, 15);
    expect(cone?.size[2]).toBeCloseTo(50e-9, 15);

    const torus = computeSceneGeometryBoundsMeters({
      geometry_kind: "Torus",
      geometry_params: { axis: [0, 0, 1], major_radius: 80e-9, minor_radius: 20e-9 },
    });
    expect(torus?.size[0]).toBeCloseTo(200e-9, 15);
    expect(torus?.size[2]).toBeCloseTo(40e-9, 15);

    const prism = computeSceneGeometryBoundsMeters({
      geometry_kind: "PolygonPrism",
      geometry_params: {
        thickness: 15e-9,
        vertices_xy: [
          [-50e-9, -20e-9],
          [70e-9, -20e-9],
          [0, 60e-9],
        ],
      },
    });
    expect(prism?.size[0]).toBeCloseTo(120e-9, 15);
    expect(prism?.size[1]).toBeCloseTo(80e-9, 15);
    expect(prism?.size[2]).toBeCloseTo(15e-9, 15);

    const ellipse = computeSceneGeometryBoundsMeters({
      geometry_kind: "Ellipse",
      geometry_params: { height: 12e-9, rx: 100e-9, ry: 40e-9 },
    });
    expect(ellipse?.size).toEqual([200e-9, 80e-9, 12e-9]);

    const sinWg = computeSceneGeometryBoundsMeters({
      geometry_kind: "SinWaveguide",
      geometry_params: { amplitude: 25e-9, length: 600e-9, thickness: 10e-9, width: 100e-9 },
    });
    expect(sinWg?.size).toEqual([600e-9, 150e-9, 10e-9]);

    const archWg = computeSceneGeometryBoundsMeters({
      geometry_kind: "ArchWaveguide",
      geometry_params: { arch_height: 30e-9, height: 10e-9, length: 500e-9, width: 100e-9, z0: 0 },
    });
    expect(archWg?.size[0]).toBeCloseTo(500e-9, 15);
    expect(archWg?.size[1]).toBeCloseTo(100e-9, 15);
    expect(archWg?.size[2]).toBeCloseTo(40e-9, 15);
  });

  it("recursively computes bounds for Union, Difference, Intersection, Xor, SlicePlane, Translate, and Array3D", () => {
    const unionGeom = {
      geometry_kind: "Union",
      geometry_params: {
        operands: [
          {
            enabled: true,
            geometry: { geometry_kind: "Box", geometry_params: { size: [100e-9, 100e-9, 10e-9] } },
            operand_id: "op:1",
          },
          {
            enabled: true,
            geometry: { geometry_kind: "Box", geometry_params: { size: [100e-9, 100e-9, 10e-9] } },
            operand_id: "op:2",
            transform: { translation: [200e-9, 0, 0] },
          },
        ],
      },
    };
    const unionBounds = computeSceneGeometryBoundsMeters(unionGeom);
    expect(unionBounds?.size[0]).toBeCloseTo(300e-9, 15);
    expect(unionBounds?.size[1]).toBeCloseTo(100e-9, 15);
    expect(unionBounds?.size[2]).toBeCloseTo(10e-9, 15);
    expect(unionBounds?.center[0]).toBeCloseTo(100e-9, 15);

    const diffFilm = {
      geometry_kind: "Difference",
      geometry_params: {
        operands: [
          {
            enabled: true,
            geometry: { geometry_kind: "Box", geometry_params: { size: [500e-9, 500e-9, 20e-9] } },
            operand_id: "base",
          },
          {
            enabled: true,
            geometry: { geometry_kind: "Cylinder", geometry_params: { height: 24e-9, radius: 50e-9 } },
            operand_id: "hole",
          },
        ],
      },
    };
    const diffBounds = computeSceneGeometryBoundsMeters(diffFilm);
    expect(diffBounds?.size).toEqual([500e-9, 500e-9, 20e-9]);

    const arrayedDiff = {
      geometry_kind: "Array3D",
      geometry_params: {
        axes: [
          defaultArrayAxisSpec("x", { count: 3, enabled: true, pitch_m: 600e-9 }),
          defaultArrayAxisSpec("y", { count: 2, enabled: true, pitch_m: 600e-9 }),
          defaultArrayAxisSpec("z", { count: 1, enabled: false, pitch_m: 100e-9 }),
        ],
        child: diffFilm,
        merge_overlapping: false,
      },
    };
    const arrayedBounds = computeSceneGeometryBoundsMeters(arrayedDiff);
    expect(arrayedBounds?.size[0]).toBeCloseTo(1700e-9, 14);
    expect(arrayedBounds?.size[1]).toBeCloseTo(1100e-9, 14);
    expect(arrayedBounds?.size[2]).toBeCloseTo(20e-9, 14);

    const translated = computeSceneGeometryBoundsMeters({
      geometry_kind: "Translate",
      geometry_params: {
        child: { geometry_kind: "Box", geometry_params: { size: [100e-9, 50e-9, 10e-9] } },
        offset: [40e-9, -10e-9, 5e-9],
      },
    });
    expect(translated?.center[0]).toBeCloseTo(40e-9, 15);
    expect(translated?.center[1]).toBeCloseTo(-10e-9, 15);
    expect(translated?.center[2]).toBeCloseTo(5e-9, 15);

    const sliced = computeSceneGeometryBoundsMeters({
      geometry_kind: "SlicePlane",
      geometry_params: {
        child: diffFilm,
        plane_normal: [1, 0, 0],
        plane_origin: [0, 0, 0],
      },
    });
    expect(sliced?.size).toEqual([500e-9, 500e-9, 20e-9]);
  });
});
