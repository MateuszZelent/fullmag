import { describe, expect, it } from "vitest";

import { defaultArrayAxisSpec } from "@/kernel/authoring/array3dModel";

import {
  compileSceneGeometryContainment,
  isPointInsideSceneGeometry,
  isWorldPointInsideSceneGeometry,
} from "./sceneGeometryContainment";

describe("sceneGeometryContainment", () => {
  it("handles Box minus Cylinder (both operands[] and legacy base/tool) and ignores disabled cutters", () => {
    const boxMinusHole = {
      geometry_kind: "Difference",
      geometry_params: {
        operands: [
          {
            enabled: true,
            geometry: {
              geometry_kind: "Box",
              geometry_params: { size: [300e-9, 300e-9, 20e-9] },
            },
            operand_id: "base",
          },
          {
            enabled: true,
            geometry: {
              geometry_kind: "Cylinder",
              geometry_params: { axis: [0, 0, 1], height: 24e-9, radius: 30e-9 },
            },
            operand_id: "hole",
          },
          {
            enabled: false,
            geometry: {
              geometry_kind: "Cylinder",
              geometry_params: { axis: [0, 0, 1], height: 24e-9, radius: 40e-9 },
            },
            operand_id: "disabled_hole",
            transform: { translation: [90e-9, 0, 0] },
          },
        ],
      },
    };

    // Inside central hole -> false (both midplane and top face)
    expect(isPointInsideSceneGeometry([0, 0, 0], boxMinusHole)).toBe(false);
    expect(isPointInsideSceneGeometry([0, 0, 10e-9], boxMinusHole)).toBe(false);
    expect(isPointInsideSceneGeometry([20e-9, 0, 0], boxMinusHole)).toBe(false);

    // Outside hole, inside film -> true
    expect(isPointInsideSceneGeometry([50e-9, 0, 0], boxMinusHole)).toBe(true);
    expect(isPointInsideSceneGeometry([-120e-9, 120e-9, 10e-9], boxMinusHole)).toBe(true);
    // Disabled cutter does NOT carve a hole at x = +90 nm
    expect(isPointInsideSceneGeometry([90e-9, 0, 0], boxMinusHole)).toBe(true);
    // Outside film -> false
    expect(isPointInsideSceneGeometry([160e-9, 0, 0], boxMinusHole)).toBe(false);
    expect(isPointInsideSceneGeometry([50e-9, 0, 15e-9], boxMinusHole)).toBe(false);

    // Legacy base/tool format
    const legacyDiff = {
      geometry_kind: "Difference",
      geometry_params: {
        base: { geometry_kind: "Box", geometry_params: { size: [100e-9, 100e-9, 10e-9] } },
        tool: { geometry_kind: "Cylinder", geometry_params: { height: 12e-9, radius: 20e-9 } },
      },
    };
    expect(isPointInsideSceneGeometry([0, 0, 0], legacyDiff)).toBe(false);
    expect(isPointInsideSceneGeometry([35e-9, 0, 0], legacyDiff)).toBe(true);
  });

  it("handles Box minus Array3D(Cylinder 3x3) antidot film — all 9 hole centers return false, film points return true", () => {
    const antidotFilm = {
      geometry_kind: "Difference",
      geometry_params: {
        operands: [
          {
            enabled: true,
            geometry: {
              geometry_kind: "Box",
              geometry_params: { size: [300e-9, 300e-9, 20e-9] },
            },
            operand_id: "op:base",
          },
          {
            enabled: true,
            geometry: {
              geometry_kind: "Array3D",
              geometry_params: {
                axes: [
                  defaultArrayAxisSpec("x", {
                    count: 3,
                    direction: "symmetric",
                    enabled: true,
                    pitch_m: 80e-9,
                  }),
                  defaultArrayAxisSpec("y", {
                    count: 3,
                    direction: "symmetric",
                    enabled: true,
                    pitch_m: 80e-9,
                  }),
                  defaultArrayAxisSpec("z", { count: 1, enabled: false, pitch_m: 100e-9 }),
                ],
                child: {
                  geometry_kind: "Cylinder",
                  geometry_params: { axis: [0, 0, 1], height: 24e-9, radius: 16e-9 },
                },
                merge_overlapping: false,
              },
            },
            operand_id: "op:holes",
          },
        ],
      },
    };

    const tester = compileSceneGeometryContainment(antidotFilm);

    // All 9 hole centers (kx, ky in {-80nm, 0, +80nm}) must be false on both midplane and top surface
    for (const hx of [-80e-9, 0, 80e-9]) {
      for (const hy of [-80e-9, 0, 80e-9]) {
        expect(tester([hx, hy, 0]), `hole (${hx}, ${hy}, 0)`).toBe(false);
        expect(tester([hx, hy, 10e-9]), `hole (${hx}, ${hy}, +hz)`).toBe(false);
        expect(tester([hx + 10e-9, hy, 0]), `near hole (${hx}, ${hy})`).toBe(false);
      }
    }

    // Film bridges between holes and outer corners must be true
    const solidPoints: readonly [number, number, number][] = [
      [40e-9, 0, 0],
      [-40e-9, 0, 10e-9],
      [0, 40e-9, 0],
      [40e-9, 40e-9, 10e-9],
      [-130e-9, -130e-9, 0],
      [130e-9, 130e-9, 10e-9],
    ];
    for (const pt of solidPoints) {
      expect(tester(pt), `film point ${pt.join(",")}`).toBe(true);
    }

    // Outside outer film bounds -> false
    expect(tester([160e-9, 0, 0])).toBe(false);
    expect(tester([40e-9, 40e-9, 12e-9])).toBe(false);
  });

  it("handles Union, Intersection, and Xor of two boxes", () => {
    const operands = [
      {
        enabled: true,
        geometry: { geometry_kind: "Box", geometry_params: { size: [100e-9, 100e-9, 10e-9] } },
        operand_id: "a",
        transform: { translation: [-30e-9, 0, 0] },
      },
      {
        enabled: true,
        geometry: { geometry_kind: "Box", geometry_params: { size: [100e-9, 100e-9, 10e-9] } },
        operand_id: "b",
        transform: { translation: [30e-9, 0, 0] },
      },
    ];
    // Box A: x in [-80, 20], Box B: x in [-20, 80], overlap: [-20, 20]
    const unionGeom = { geometry_kind: "Union", geometry_params: { operands } };
    const intersectGeom = { geometry_kind: "Intersection", geometry_params: { operands } };
    const xorGeom = { geometry_kind: "Xor", geometry_params: { operands } };

    // Union
    expect(isPointInsideSceneGeometry([-60e-9, 0, 0], unionGeom)).toBe(true);
    expect(isPointInsideSceneGeometry([0, 0, 0], unionGeom)).toBe(true);
    expect(isPointInsideSceneGeometry([60e-9, 0, 0], unionGeom)).toBe(true);
    expect(isPointInsideSceneGeometry([0, 60e-9, 0], unionGeom)).toBe(false);

    // Intersection (overlap only)
    expect(isPointInsideSceneGeometry([0, 0, 0], intersectGeom)).toBe(true);
    expect(isPointInsideSceneGeometry([-60e-9, 0, 0], intersectGeom)).toBe(false);
    expect(isPointInsideSceneGeometry([60e-9, 0, 0], intersectGeom)).toBe(false);

    // Xor (excludes overlap)
    expect(isPointInsideSceneGeometry([-60e-9, 0, 0], xorGeom)).toBe(true);
    expect(isPointInsideSceneGeometry([60e-9, 0, 0], xorGeom)).toBe(true);
    expect(isPointInsideSceneGeometry([0, 0, 0], xorGeom)).toBe(false);

    // Disjoint Union gap returns false
    const disjointUnion = {
      geometry_kind: "Union",
      geometry_params: {
        operands: [
          {
            enabled: true,
            geometry: { geometry_kind: "Box", geometry_params: { size: [50e-9, 50e-9, 10e-9] } },
            transform: { translation: [-100e-9, 0, 0] },
          },
          {
            enabled: true,
            geometry: { geometry_kind: "Box", geometry_params: { size: [50e-9, 50e-9, 10e-9] } },
            transform: { translation: [100e-9, 0, 0] },
          },
        ],
      },
    };
    expect(isPointInsideSceneGeometry([-100e-9, 0, 0], disjointUnion)).toBe(true);
    expect(isPointInsideSceneGeometry([100e-9, 0, 0], disjointUnion)).toBe(true);
    expect(isPointInsideSceneGeometry([0, 0, 0], disjointUnion)).toBe(false);
  });

  it("handles Cylinder, Sphere, Ellipsoid, Cone, Torus, Tube, and concave PolygonPrism", () => {
    // Cylinder along X
    const cylX = {
      geometry_kind: "Cylinder",
      geometry_params: { axis: [1, 0, 0], height: 100e-9, radius: 20e-9 },
    };
    expect(isPointInsideSceneGeometry([45e-9, 10e-9, 0], cylX)).toBe(true);
    expect(isPointInsideSceneGeometry([45e-9, 25e-9, 0], cylX)).toBe(false);
    expect(isPointInsideSceneGeometry([60e-9, 0, 0], cylX)).toBe(false);

    // Sphere
    const sphere = { geometry_kind: "Sphere", geometry_params: { radius: 40e-9 } };
    expect(isPointInsideSceneGeometry([20e-9, 20e-9, 20e-9], sphere)).toBe(true);
    expect(isPointInsideSceneGeometry([30e-9, 30e-9, 0], sphere)).toBe(false);

    // Ellipsoid
    const ellipsoid = {
      geometry_kind: "Ellipsoid",
      geometry_params: { radii: [60e-9, 30e-9, 10e-9] },
    };
    expect(isPointInsideSceneGeometry([50e-9, 0, 0], ellipsoid)).toBe(true);
    expect(isPointInsideSceneGeometry([0, 40e-9, 0], ellipsoid)).toBe(false);

    // Cone (radius 40nm at z=-25nm tapering to 10nm at z=+25nm)
    const cone = {
      geometry_kind: "Cone",
      geometry_params: { axis: [0, 0, 1], height: 50e-9, radius_bottom: 40e-9, radius_top: 10e-9 },
    };
    expect(isPointInsideSceneGeometry([30e-9, 0, -20e-9], cone)).toBe(true);
    expect(isPointInsideSceneGeometry([30e-9, 0, 20e-9], cone)).toBe(false);
    expect(isPointInsideSceneGeometry([5e-9, 0, 20e-9], cone)).toBe(true);

    // Torus (major 80nm, minor 20nm in XY plane)
    const torus = {
      geometry_kind: "Torus",
      geometry_params: { axis: [0, 0, 1], major_radius: 80e-9, minor_radius: 20e-9 },
    };
    expect(isPointInsideSceneGeometry([80e-9, 0, 0], torus)).toBe(true);
    expect(isPointInsideSceneGeometry([0, 0, 0], torus)).toBe(false); // center hole
    expect(isPointInsideSceneGeometry([80e-9, 0, 25e-9], torus)).toBe(false);

    // Tube / Ring
    const tube = {
      geometry_kind: "Tube",
      geometry_params: { axis: [0, 0, 1], height: 20e-9, inner_radius: 20e-9, outer_radius: 50e-9 },
    };
    expect(isPointInsideSceneGeometry([35e-9, 0, 0], tube)).toBe(true);
    expect(isPointInsideSceneGeometry([10e-9, 0, 0], tube)).toBe(false);
    expect(isPointInsideSceneGeometry([60e-9, 0, 0], tube)).toBe(false);

    // Concave L-shaped PolygonPrism
    const lPrism = {
      geometry_kind: "PolygonPrism",
      geometry_params: {
        thickness: 20e-9,
        vertices_xy: [
          [0, 0],
          [100e-9, 0],
          [100e-9, 30e-9],
          [30e-9, 30e-9],
          [30e-9, 100e-9],
          [0, 100e-9],
        ],
      },
    };
    expect(isPointInsideSceneGeometry([15e-9, 15e-9, 0], lPrism)).toBe(true);
    expect(isPointInsideSceneGeometry([15e-9, 80e-9, 0], lPrism)).toBe(true);
    expect(isPointInsideSceneGeometry([80e-9, 15e-9, 0], lPrism)).toBe(true);
    expect(isPointInsideSceneGeometry([70e-9, 70e-9, 0], lPrism)).toBe(false); // concave notch
    expect(isPointInsideSceneGeometry([15e-9, 15e-9, 15e-9], lPrism)).toBe(false);
  });

  it("handles rotated Box via Transform/Translate wrapper, SlicePlane, top-level Array3D, and world transform", () => {
    // 90 deg rotation around Z swaps X and Y axes of a 200 x 40 x 10 nm bar
    const q90z: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    const rotatedBar = {
      geometry_kind: "Transform",
      geometry_params: {
        child: {
          geometry_kind: "Box",
          geometry_params: { size: [200e-9, 40e-9, 10e-9] },
        },
        transform: {
          rotation_quat: q90z,
          translation: [10e-9, 0, 0],
        },
      },
    };
    // After 90 deg Z rotation + X=10nm translation, long axis is along Y at x=10nm
    expect(isPointInsideSceneGeometry([10e-9, 80e-9, 0], rotatedBar)).toBe(true);
    expect(isPointInsideSceneGeometry([80e-9, 0, 0], rotatedBar)).toBe(false);

    // World-space transform helper on raw Box
    const rawBar = { geometry_kind: "Box", geometry_params: { size: [200e-9, 40e-9, 10e-9] } };
    expect(
      isWorldPointInsideSceneGeometry([10e-9, 80e-9, 0], rawBar, {
        rotationQuat: q90z,
        translation: [10e-9, 0, 0],
      }),
    ).toBe(true);
    expect(
      isWorldPointInsideSceneGeometry([80e-9, 0, 0], rawBar, {
        rotationQuat: q90z,
        translation: [10e-9, 0, 0],
      }),
    ).toBe(false);

    // SlicePlane keeping positive X half of a box
    const slicedBox = {
      geometry_kind: "SlicePlane",
      geometry_params: {
        child: { geometry_kind: "Box", geometry_params: { size: [100e-9, 100e-9, 10e-9] } },
        keep_side: "positive",
        plane_normal: [1, 0, 0],
        plane_origin_m: [0, 0, 0],
      },
    };
    expect(isPointInsideSceneGeometry([20e-9, 0, 0], slicedBox)).toBe(true);
    expect(isPointInsideSceneGeometry([-20e-9, 0, 0], slicedBox)).toBe(false);

    // Top-level Array3D of 2x2 cylinders with 100nm pitch and 20nm radius (empty gaps between!)
    const dotArray = {
      geometry_kind: "Array3D",
      geometry_params: {
        axes: [
          defaultArrayAxisSpec("x", { count: 2, direction: "symmetric", enabled: true, pitch_m: 100e-9 }),
          defaultArrayAxisSpec("y", { count: 2, direction: "symmetric", enabled: true, pitch_m: 100e-9 }),
          defaultArrayAxisSpec("z", { count: 1, enabled: false, pitch_m: 100e-9 }),
        ],
        child: {
          geometry_kind: "Cylinder",
          geometry_params: { axis: [0, 0, 1], height: 10e-9, radius: 20e-9 },
        },
        merge_overlapping: false,
      },
    };
    // Centers at (±50nm, ±50nm) are inside; origin (0, 0) is empty gap!
    expect(isPointInsideSceneGeometry([-50e-9, -50e-9, 0], dotArray)).toBe(true);
    expect(isPointInsideSceneGeometry([50e-9, 50e-9, 0], dotArray)).toBe(true);
    expect(isPointInsideSceneGeometry([0, 0, 0], dotArray)).toBe(false);
    expect(isPointInsideSceneGeometry([50e-9, 0, 0], dotArray)).toBe(false);
  });
});
