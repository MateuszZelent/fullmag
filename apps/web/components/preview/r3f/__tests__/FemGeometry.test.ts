import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { resolveFemClipPlane, resolveFemGeometryResourceNeeds } from "../FemGeometry";
import { resolveFemGeometryRenderPasses } from "../femGeometryRenderPasses";

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

describe("resolveFemGeometryRenderPasses", () => {
  it("uses explicit render passes instead of legacy exclusive render mode", () => {
    expect(
      resolveFemGeometryRenderPasses({
        renderMode: "points",
        renderPasses: {
          surface: true,
          wireframe: true,
          volumeMesh: false,
          points: true,
        },
        hasGeometry: true,
        hasEdgesGeometry: true,
        showSurfacePass: true,
        showSurfaceHiddenEdgesPass: true,
        showSurfaceVisibleEdgesPass: true,
        showPointsPass: true,
      }),
    ).toMatchObject({
      showSurface: true,
      showSurfaceEdges: true,
      showPoints: true,
    });
  });

  it("keeps airbox vectors/points independent from shaded surface", () => {
    expect(
      resolveFemGeometryRenderPasses({
        renderMode: "surface",
        renderPasses: {
          surface: false,
          wireframe: true,
          volumeMesh: false,
          points: true,
        },
        hasGeometry: true,
        hasEdgesGeometry: true,
        edgeScope: "surface",
        pointsScope: "surface",
        showSurfacePass: true,
        showSurfaceHiddenEdgesPass: true,
        showSurfaceVisibleEdgesPass: true,
        showPointsPass: true,
      }),
    ).toMatchObject({
      showSurface: false,
      showWireOnlyEdges: true,
      showPoints: true,
    });
  });
});

describe("resolveFemGeometryResourceNeeds", () => {
  it("does not allocate edge or point resources when explicit passes hide them", () => {
    expect(
      resolveFemGeometryResourceNeeds({
        renderMode: "surface+edges",
        renderPasses: {
          surface: true,
          wireframe: false,
          volumeMesh: false,
          points: false,
        },
      }),
    ).toEqual({
      edges: false,
      tetraEdges: false,
      points: false,
    });
  });

  it("allocates only resources required by independent pass state", () => {
    expect(
      resolveFemGeometryResourceNeeds({
        renderMode: "surface",
        renderPasses: {
          surface: false,
          wireframe: true,
          volumeMesh: false,
          points: true,
        },
      }),
    ).toEqual({
      edges: true,
      tetraEdges: false,
      points: true,
    });
  });
});
