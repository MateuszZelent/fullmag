import { describe, expect, it } from "vitest";

import type { DecodedTopology } from "@/kernel/api/codecs";
import type { MeshSizeHistogramHighlight } from "@/kernel/events/eventTypes";

import type { FemManifestRenderDomain } from "./viewport3dDomainAdapter";
import { buildViewport3DMeshSizeHighlightModel } from "./viewport3dMeshSizeHighlight";
import type { Viewport3DTopologyRenderModel } from "./viewport3dRenderModel";

function topologyFixture(): DecodedTopology {
  return {
    boundaryFaceCount: 0,
    boundaryFaces: new Uint32Array(),
    boundaryMarkers: new Uint32Array(),
    elementCount: 2,
    elementMarkers: new Uint32Array([0, 1]),
    indices: new Uint32Array([
      0, 1, 2, 3,
      4, 5, 6, 7,
    ]),
    nodeCount: 8,
    positions: new Float64Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
      0, 0, 0,
      2, 0, 0,
      0, 2, 0,
      0, 0, 2,
    ]),
  };
}

function topologyModelFixture(): Viewport3DTopologyRenderModel {
  return {
    airboxParts: [],
    fallbackSurfaceIndices: new Uint32Array(),
    fallbackVolumeEdgeIndices: new Uint32Array(),
    magneticParts: [],
    meshGenerationId: null,
    meshRevision: null,
    nodeCount: 8,
    positions: Float32Array.from(topologyFixture().positions),
  };
}

function femDomainFixture(): FemManifestRenderDomain {
  const airboxPart = {
    boundary_face_count: 0,
    boundary_face_start: 0,
    element_count: 1,
    element_start: 0,
    id: "part:__air__",
    label: "Airbox",
    node_count: 4,
    node_start: 0,
    role: "air",
  };
  const objectPart = {
    boundary_face_count: 0,
    boundary_face_start: 0,
    element_count: 1,
    element_start: 1,
    geometry_id: "arch_waveguide_geom",
    id: "arch_waveguide",
    label: "arch_waveguide",
    node_count: 4,
    node_start: 4,
    object_id: "arch_waveguide",
    role: "magnetic",
  };
  return {
    airboxParts: [airboxPart],
    magneticParts: [objectPart],
    magneticSurfacePartsByPartId: new Map(),
    objectPartIds: new Map([
      ["arch_waveguide", ["arch_waveguide"]],
      ["arch_waveguide_geom", ["arch_waveguide"]],
    ]),
    partsById: new Map([
      [airboxPart.id, airboxPart],
      [objectPart.id, objectPart],
    ]),
  };
}

function highlight(
  patch: Partial<MeshSizeHistogramHighlight>,
): MeshSizeHistogramHighlight {
  return {
    binLabel: "1.00 to 1.50",
    count: 1,
    distributionId: "tetra_size",
    distributionLabel: "Tetra size",
    hi: 1.5,
    lo: 1,
    resource: null,
    scope: { kind: "all" },
    ...patch,
  };
}

describe("buildViewport3DMeshSizeHighlightModel", () => {
  it("highlights only airbox tetrahedra inside the hovered size bin", () => {
    const model = buildViewport3DMeshSizeHighlightModel(
      topologyFixture(),
      topologyModelFixture(),
      femDomainFixture(),
      highlight({ scope: { kind: "airbox" } }),
    );

    expect(model?.eligibleElementCount).toBe(1);
    expect(model?.matchedElementCount).toBe(1);
    expect(model?.sampledElementCount).toBe(1);
    expect(model?.edgeIndices).toHaveLength(12);
  });

  it("uses object mesh-part ranges for object-scoped histogram hover", () => {
    const model = buildViewport3DMeshSizeHighlightModel(
      topologyFixture(),
      topologyModelFixture(),
      femDomainFixture(),
      highlight({
        binLabel: "2.00 to 3.00",
        hi: 3,
        lo: 2,
        scope: { kind: "object", objectId: "arch_waveguide" },
      }),
    );

    expect(model?.eligibleElementCount).toBe(1);
    expect(model?.matchedElementCount).toBe(1);
    expect(Array.from(model?.edgeIndices ?? [])).toContain(7);
  });

  it("maps edge-length bins to tetrahedra containing matching edges", () => {
    const model = buildViewport3DMeshSizeHighlightModel(
      topologyFixture(),
      topologyModelFixture(),
      femDomainFixture(),
      highlight({
        binLabel: "1.90 to 2.10",
        distributionId: "edge_length",
        distributionLabel: "Edge length",
        hi: 2.1,
        lo: 1.9,
      }),
    );

    expect(model?.matchedElementCount).toBe(1);
    expect(Array.from(model?.edgeIndices ?? [])).toContain(5);
  });

  it("uses API-selected source element indices when provided", () => {
    const model = buildViewport3DMeshSizeHighlightModel(
      topologyFixture(),
      topologyModelFixture(),
      femDomainFixture(),
      highlight({
        hi: 0.1,
        lo: 0,
        scope: { kind: "airbox" },
      }),
      { elementIndices: [1] },
    );

    expect(model?.matchedElementCount).toBe(1);
    expect(model?.sampledElementCount).toBe(1);
    expect(Array.from(model?.edgeIndices ?? [])).toContain(7);
  });
});
