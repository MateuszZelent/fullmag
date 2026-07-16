import { describe, expect, it } from "vitest";

import type { MeshPeriodicPairsResource } from "@/kernel/api/apiTypes";
import type { DecodedTopology } from "@/kernel/api/codecs";

import { buildPeriodicOverlayModel } from "./periodicOverlayModel";

function topology(): DecodedTopology {
  return {
    boundaryFaceCount: 3,
    boundaryFaces: new Uint32Array([0, 1, 2, 0, 2, 3, 0, 3, 1]),
    boundaryMarkers: new Uint32Array([1, 2, 3]),
    elementCount: 0,
    elementMarkers: new Uint32Array(),
    indices: new Uint32Array(),
    nodeCount: 4,
    positions: new Float64Array([
      0, 0, 0,
      1, 0, 0,
      1, 1, 0,
      0, 1, 0,
    ]),
  };
}

function resource(
  overrides: Partial<MeshPeriodicPairsResource> = {},
): MeshPeriodicPairsResource {
  return {
    certificate_fingerprint: "cert-1",
    pairs: [
      {
        boundary_face_pairs: [
          {
            face_a: 0,
            face_b: 1,
            orientation: "opposed_normals",
            translation_m: [0, 1, 0],
            vertex_pairs: [[0, 2], [1, 3]],
          },
        ],
        marker_a: 1,
        marker_b: 1,
        node_pairs: [[0, 2], [1, 3]],
        pair_id: "x_faces",
        paired_node_count: 2,
        status: "valid",
        unpaired_destination_node_count: 0,
        unpaired_source_node_count: 0,
      },
    ],
    revision: 7,
    schema_version: "periodic_pairs.v1",
    status: "valid",
    topology_fingerprint: "topology-1",
    ...overrides,
  };
}

describe("periodic viewport overlay model", () => {
  it("builds bounded face, node-link, and translation-arrow glyphs", () => {
    const model = buildPeriodicOverlayModel({
      currentCertificateFingerprint: "cert-1",
      currentMeshRevision: 7,
      currentTopologyFingerprint: "topology-1",
      markerDomainById: new Map([[1, "magnetic"]]),
      resource: resource(),
      topology: topology(),
    });

    expect(model.status).toBe("valid");
    expect(model.facePairs).toHaveLength(1);
    expect(model.nodeLinks).toHaveLength(2);
    expect(model.arrows).toHaveLength(1);
    expect(model.unpaired).toHaveLength(1);
    expect(model.counts).toEqual({ facePairs: 1, nodeLinks: 2, unpaired: 1 });
    expect(model.facePairs[0]?.domain).toBe("magnetic");
  });

  it("marks a pair mixed when its certified markers belong to different domains", () => {
    const model = buildPeriodicOverlayModel({
      currentCertificateFingerprint: "cert-1",
      currentMeshRevision: 7,
      currentTopologyFingerprint: "topology-1",
      markerDomainById: new Map([
        [1, "magnetic"],
        [2, "airbox"],
      ]),
      resource: resource({
        pairs: [
          {
            ...resource().pairs[0]!,
            marker_b: 2,
          },
        ],
      }),
      topology: topology(),
    });

    expect(model.status).toBe("valid");
    expect(model.facePairs[0]?.domain).toBe("mixed");
  });

  it("suppresses stale certificates instead of rendering them as current", () => {
    const model = buildPeriodicOverlayModel({
      currentCertificateFingerprint: "cert-2",
      currentMeshRevision: 8,
      currentTopologyFingerprint: "topology-2",
      resource: resource(),
      topology: topology(),
    });

    expect(model.status).toBe("stale");
    expect(model.facePairs).toEqual([]);
    expect(model.nodeLinks).toEqual([]);
    expect(model.unpaired).toEqual([]);
    expect(model.reason).toContain("current mesh");
  });

  it("fails closed for invalid certificate status", () => {
    const model = buildPeriodicOverlayModel({
      currentMeshRevision: 7,
      resource: resource({ status: "invalid" }),
      topology: topology(),
    });

    expect(model.status).toBe("invalid");
    expect(model.arrows).toEqual([]);
    expect(model.reason).toContain("invalid");
  });
});
