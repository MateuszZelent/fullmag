import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  buildFemPointsGeometryResource,
  buildFemSurfaceEdgeGeometryResource,
  buildFemVolumeEdgeGeometryResource,
  estimateVolumeEdgeBytes,
  resolveFemGeometryResourceNeeds,
  VOLUME_EDGE_BYTE_BUDGET_DEFAULT,
} from "../femGeometryResources";

describe("femGeometryResources", () => {
  it("does not allocate resource passes hidden by the render plan", () => {
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

  it("builds surface edge geometry only when requested", () => {
    const surface = new THREE.BufferGeometry();
    surface.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    );
    surface.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2]), 1));

    expect(buildFemSurfaceEdgeGeometryResource({ enabled: false, geometry: surface })).toBeNull();
    const edges = buildFemSurfaceEdgeGeometryResource({ enabled: true, geometry: surface });

    expect(edges?.getAttribute("position")?.count).toBeGreaterThan(0);

    surface.dispose();
    edges?.dispose();
  });

  it("deduplicates tetrahedral volume edges", () => {
    const geometry = buildFemVolumeEdgeGeometryResource({
      enabled: true,
      nElements: 2,
      nNodes: 5,
      elements: new Uint32Array([
        0, 1, 2, 3,
        0, 1, 2, 4,
      ]),
      nodes: new Float32Array([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
        0, 0, -1,
      ]),
      centerX: 0,
      centerY: 0,
      centerZ: 0,
    });

    expect(geometry?.getAttribute("position")?.count).toBe(18);

    geometry?.dispose();
  });

  it("builds point geometry from the visible surface vertex map", () => {
    const surface = new THREE.BufferGeometry();
    surface.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
      ]), 3),
    );

    const resource = buildFemPointsGeometryResource({
      enabled: true,
      pointsScope: "surface",
      surfaceGeometry: surface,
      vertexMap: new Int32Array([4, 8, 15]),
      nNodes: 16,
      enableGeometryVertexColors: true,
      positions: null,
      boundaryFaces: new Uint32Array(0),
      customBoundaryFaces: null,
      activeElementOffsets: [],
      elements: new Uint32Array(0),
      nElements: 0,
      preferredFaceIndices: null,
    });

    expect(resource.pointsGeometry?.getAttribute("position")?.count).toBe(3);
    expect(resource.pointsGeometry?.getAttribute("color")?.count).toBe(3);
    expect(Array.from(resource.pointsVertexMap ?? [])).toEqual([4, 8, 15]);

    surface.dispose();
    resource.pointsGeometry?.dispose();
  });

  it("returns no points geometry when the points pass is disabled", () => {
    const resource = buildFemPointsGeometryResource({
      enabled: false,
      pointsScope: "surface",
      surfaceGeometry: null,
      vertexMap: null,
      nNodes: 0,
      enableGeometryVertexColors: true,
      positions: null,
      boundaryFaces: new Uint32Array(0),
      customBoundaryFaces: null,
      activeElementOffsets: [],
      elements: new Uint32Array(0),
      nElements: 0,
      preferredFaceIndices: null,
    });

    expect(resource).toEqual({ pointsGeometry: null, pointsVertexMap: null });
  });

  it("acceptance: points=false does not create pointsGeometry", () => {
    const surface = new THREE.BufferGeometry();
    surface.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    );
    const needs = resolveFemGeometryResourceNeeds({
      renderMode: "surface+edges",
      renderPasses: { surface: true, wireframe: true, volumeMesh: false, points: false },
    });

    expect(needs.points).toBe(false);

    const resource = buildFemPointsGeometryResource({
      enabled: needs.points,
      pointsScope: "surface",
      surfaceGeometry: surface,
      vertexMap: null,
      nNodes: 3,
      enableGeometryVertexColors: false,
      positions: null,
      boundaryFaces: new Uint32Array(0),
      customBoundaryFaces: null,
      activeElementOffsets: [],
      elements: new Uint32Array(0),
      nElements: 0,
      preferredFaceIndices: null,
    });

    expect(resource.pointsGeometry).toBeNull();
    surface.dispose();
  });

  it("acceptance: wireframe=false does not create WireframeGeometry", () => {
    const surface = new THREE.BufferGeometry();
    surface.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    );
    surface.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2]), 1));

    const needs = resolveFemGeometryResourceNeeds({
      renderMode: "surface",
      renderPasses: { surface: true, wireframe: false, volumeMesh: false, points: false },
    });

    expect(needs.edges).toBe(false);

    const edgesResult = buildFemSurfaceEdgeGeometryResource({
      enabled: needs.edges,
      geometry: surface,
    });

    expect(edgesResult).toBeNull();
    surface.dispose();
  });

  it("acceptance: points color attribute is NOT created when enableGeometryVertexColors=false", () => {
    const surface = new THREE.BufferGeometry();
    surface.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    );

    const resource = buildFemPointsGeometryResource({
      enabled: true,
      pointsScope: "surface",
      surfaceGeometry: surface,
      vertexMap: null,
      nNodes: 3,
      enableGeometryVertexColors: false,
      positions: null,
      boundaryFaces: new Uint32Array(0),
      customBoundaryFaces: null,
      activeElementOffsets: [],
      elements: new Uint32Array(0),
      nElements: 0,
      preferredFaceIndices: null,
    });

    expect(resource.pointsGeometry?.getAttribute("color")).toBeUndefined();
    surface.dispose();
    resource.pointsGeometry?.dispose();
  });

  // ── Volume edge byte budget ───────────────────────────────────────────────

  describe("estimateVolumeEdgeBytes", () => {
    it("returns 0 for 0 elements", () => {
      expect(estimateVolumeEdgeBytes(0)).toBe(0);
    });

    it("is proportional to element count at 144 bytes/element", () => {
      // 6 edges/tet × 2 endpoints × 3 coords × 4 bytes = 144
      expect(estimateVolumeEdgeBytes(1000)).toBe(1000 * 144);
      expect(estimateVolumeEdgeBytes(50_000)).toBe(50_000 * 144);
    });

    it("VOLUME_EDGE_BYTE_BUDGET_DEFAULT covers at least 100 K elements", () => {
      expect(estimateVolumeEdgeBytes(100_000)).toBeLessThan(VOLUME_EDGE_BYTE_BUDGET_DEFAULT);
    });
  });

  describe("buildFemVolumeEdgeGeometryResource — maxBytes guard", () => {
    const SMALL_MESH = {
      enabled: true,
      nElements: 2,
      nNodes: 5,
      elements: new Uint32Array([0, 1, 2, 3, 0, 1, 2, 4]),
      nodes: new Float32Array([
        0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1,
      ]),
      centerX: 0,
      centerY: 0,
      centerZ: 0,
    } as const;

    it("builds geometry when under budget", () => {
      const geo = buildFemVolumeEdgeGeometryResource({
        ...SMALL_MESH,
        maxBytes: VOLUME_EDGE_BYTE_BUDGET_DEFAULT,
      });
      expect(geo).not.toBeNull();
      geo?.dispose();
    });

    it("returns null when estimated bytes exceed maxBytes", () => {
      // 2 elements × 144 bytes = 288 — budget of 1 byte triggers the guard.
      const geo = buildFemVolumeEdgeGeometryResource({
        ...SMALL_MESH,
        maxBytes: 1,
      });
      expect(geo).toBeNull();
    });

    it("builds geometry when maxBytes is undefined (no cap)", () => {
      const geo = buildFemVolumeEdgeGeometryResource({ ...SMALL_MESH });
      expect(geo).not.toBeNull();
      geo?.dispose();
    });

    it("budget guard is tight: exactly at limit still passes", () => {
      const exactBudget = estimateVolumeEdgeBytes(SMALL_MESH.nElements);
      // estimatedBytes === maxBytes → should build (> not >=)
      const geo = buildFemVolumeEdgeGeometryResource({
        ...SMALL_MESH,
        maxBytes: exactBudget,
      });
      expect(geo).not.toBeNull();
      geo?.dispose();
    });

    it("budget guard triggers one byte below limit", () => {
      const exactBudget = estimateVolumeEdgeBytes(SMALL_MESH.nElements);
      const geo = buildFemVolumeEdgeGeometryResource({
        ...SMALL_MESH,
        maxBytes: exactBudget - 1,
      });
      expect(geo).toBeNull();
    });
  });
});
