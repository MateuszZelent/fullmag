import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildFemArrowInstancePayload,
  resolveFemArrowStableCapacity,
} from "../femArrowResources";
import {
  buildFemPointsGeometryResource,
  buildFemSurfaceEdgeGeometryResource,
  buildFemVolumeEdgeGeometryResource,
  resolveFemGeometryResourceNeeds,
} from "../femGeometryResources";
import {
  estimateThreeBufferGeometryBytes,
  getViewportResourceManagerStats,
  releaseViewportResource,
  resetViewportResourceManagerForTests,
  trackViewportResource,
} from "@/lib/debug/viewportResourceManager";
import { resolveContextLossRecovery } from "../../shared/ScientificViewportShell";
import type { FemMeshData } from "../../fem/femMeshTypes";

function makeStressMesh(): FemMeshData {
  return {
    nNodes: 5,
    nElements: 2,
    nodes: new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
      1, 1, 1,
    ]),
    elements: new Uint32Array([
      0, 1, 2, 3,
      1, 2, 3, 4,
    ]),
    boundaryFaces: new Uint32Array([
      0, 1, 2,
      0, 1, 3,
      0, 2, 3,
      1, 2, 4,
      1, 3, 4,
      2, 3, 4,
    ]),
    fieldData: {
      x: new Float32Array([1, 0, -1, 0.4, -0.2]),
      y: new Float32Array([0, 1, 0.2, -0.4, 0.8]),
      z: new Float32Array([0.2, -0.1, 1, 0, -0.3]),
    },
    fieldNComp: 3,
    quantityDomain: "full_domain",
  } as unknown as FemMeshData;
}

function makeSurfaceGeometry(mesh: FemMeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(mesh.nodes), 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.boundaryFaces), 1));
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(mesh.nNodes * 3), 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function trackGeometry(key: string, label: string, geometry: THREE.BufferGeometry | null): void {
  if (!geometry) return;
  trackViewportResource({
    key,
    owner: "viewport-memory-stress",
    label,
    resource: geometry,
    estimatedBytes: estimateThreeBufferGeometryBytes(geometry),
    dispose: () => geometry.dispose(),
  });
}

function releaseCycleResources(): void {
  releaseViewportResource("stress:surface");
  releaseViewportResource("stress:edges");
  releaseViewportResource("stress:tetraEdges");
  releaseViewportResource("stress:points");
  releaseViewportResource("stress:arrowInstances");
}

describe("viewport memory stress", () => {
  afterEach(() => {
    resetViewportResourceManagerForTests();
  });

  it("keeps resource-manager bytes flat across 100 viewport toggle cycles", () => {
    resetViewportResourceManagerForTests();
    const mesh = makeStressMesh();
    const renderModes = ["surface", "wireframe", "surface+edges", "points"] as const;
    const components = ["magnitude", "x", "y", "z"] as const;
    let capacity = 1;
    let capacityChanges = 0;
    let exactCountChanges = 0;
    let previousExactCount = 1;
    let peakBytes = 0;

    for (let cycle = 0; cycle < 100; cycle += 1) {
      const vectorsVisible = cycle % 2 === 0;
      const airboxVisible = cycle % 3 !== 0;
      const renderMode = renderModes[cycle % renderModes.length];
      const component = components[cycle % components.length];
      const renderPasses = {
        surface: airboxVisible && (renderMode === "surface" || renderMode === "surface+edges"),
        wireframe: airboxVisible && (renderMode === "wireframe" || renderMode === "surface+edges"),
        volumeMesh: cycle % 11 === 0,
        points: airboxVisible && renderMode === "points",
      };
      const needs = resolveFemGeometryResourceNeeds({
        renderMode,
        renderPasses,
        edgeScope: cycle % 5 === 0 ? "full" : "surface",
      });
      const surface = makeSurfaceGeometry(mesh);
      trackGeometry("stress:surface", "Stress surface geometry", surface);
      trackGeometry(
        "stress:edges",
        "Stress edge geometry",
        buildFemSurfaceEdgeGeometryResource({
          enabled: needs.edges,
          geometry: surface,
        }),
      );
      trackGeometry(
        "stress:tetraEdges",
        "Stress tetra edge geometry",
        buildFemVolumeEdgeGeometryResource({
          enabled: needs.tetraEdges,
          nElements: mesh.nElements,
          nNodes: mesh.nNodes,
          elements: mesh.elements,
          nodes: mesh.nodes,
          centerX: 0,
          centerY: 0,
          centerZ: 0,
        }),
      );
      const points = buildFemPointsGeometryResource({
        enabled: needs.points,
        pointsScope: cycle % 7 === 0 ? "full" : "surface",
        surfaceGeometry: surface,
        vertexMap: null,
        nNodes: mesh.nNodes,
        enableGeometryVertexColors: true,
        positions: mesh.nodes as Float32Array,
        boundaryFaces: mesh.boundaryFaces,
        customBoundaryFaces: null,
        activeElementOffsets: [0, 4],
        elements: mesh.elements,
        nElements: mesh.nElements,
        preferredFaceIndices: null,
      });
      trackGeometry("stress:points", "Stress points geometry", points.pointsGeometry);

      if (vectorsVisible) {
        const payload = buildFemArrowInstancePayload({
          arrowTemplateScale: 0.1,
          center: new THREE.Vector3(0, 0, 0),
          colorMode: component === "magnitude" ? "magnitude" : component,
          field: component,
          lengthMode: cycle % 4 === 0 ? "sqrt" : "magnitude",
          lengthScale: 1 + (cycle % 3) * 0.2,
          meshData: mesh,
          monoColor: "#ffffff",
          sampledNodes: [0, 1, 2, 3, 4].slice(0, 1 + (cycle % 5)),
          thickness: 1,
          visible: true,
        });
        const nextCapacity = resolveFemArrowStableCapacity(payload.count, capacity);
        if (nextCapacity !== capacity) capacityChanges += 1;
        if (payload.count !== previousExactCount) exactCountChanges += 1;
        previousExactCount = payload.count;
        capacity = nextCapacity;
        trackViewportResource({
          key: "stress:arrowInstances",
          owner: "viewport-memory-stress",
          label: "Stress arrow instance buffers",
          resource: payload,
          estimatedBytes: capacity * (16 + 3) * Float32Array.BYTES_PER_ELEMENT,
          dispose: () => {},
        });
      }

      const activeStats = getViewportResourceManagerStats();
      peakBytes = Math.max(peakBytes, activeStats.estimatedBytes);
      expect(activeStats.entries).toBeLessThanOrEqual(5);

      releaseCycleResources();

      const idleStats = getViewportResourceManagerStats();
      expect(idleStats.entries).toBe(0);
      expect(idleStats.estimatedBytes).toBe(0);
    }

    const finalStats = getViewportResourceManagerStats();
    expect(finalStats.entries).toBe(0);
    expect(finalStats.estimatedBytes).toBe(0);
    expect(finalStats.disposed).toBe(finalStats.created);
    expect(peakBytes).toBeGreaterThan(0);
    expect(capacityChanges).toBeLessThan(exactCountChanges);
  });

  it("fails bounded context-loss retry after repeated stress-triggered losses", () => {
    const first = resolveContextLossRecovery({ nowMs: 1_000, retryTimestamps: [] });
    const second = resolveContextLossRecovery({ nowMs: 1_100, retryTimestamps: first.nextTimestamps });
    const third = resolveContextLossRecovery({ nowMs: 1_200, retryTimestamps: second.nextTimestamps });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
  });
});
