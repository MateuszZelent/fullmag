import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { resolveFemClipPlane } from "../FemGeometry";

describe("resolveFemClipPlane", () => {
  it("returns null when clipping is disabled or geometry has no extent", () => {
    expect(
      resolveFemClipPlane({
        enabled: false,
        axis: "x",
        clipPos: 50,
        size: new THREE.Vector3(10, 10, 10),
      }),
    ).toBeNull();
    expect(
      resolveFemClipPlane({
        enabled: true,
        axis: "x",
        clipPos: 50,
        size: new THREE.Vector3(0, 10, 10),
      }),
    ).toBeNull();
  });

  it("maps clip percent to the centered local geometry extent", () => {
    const plane = resolveFemClipPlane({
      enabled: true,
      axis: "x",
      clipPos: 75,
      size: new THREE.Vector3(8, 4, 2),
    });

    expect(plane?.normal.toArray()).toEqual([-1, 0, 0]);
    expect(plane?.constant).toBe(2);
  });

  it("uses the selected axis extent and orientation", () => {
    const yPlane = resolveFemClipPlane({
      enabled: true,
      axis: "y",
      clipPos: 0,
      size: new THREE.Vector3(8, 4, 2),
    });
    const zPlane = resolveFemClipPlane({
      enabled: true,
      axis: "z",
      clipPos: 100,
      size: new THREE.Vector3(8, 4, 2),
    });

    expect(yPlane?.normal.toArray()).toEqual([0, -1, 0]);
    expect(yPlane?.constant).toBe(-2);
    expect(zPlane?.normal.toArray()).toEqual([0, 0, -1]);
    expect(zPlane?.constant).toBe(1);
  });
});
