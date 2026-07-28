import type { MeshPeriodicPairsResource } from "@/kernel/api/apiTypes";
import type { DecodedTopology } from "@/kernel/api/codecs";

export type PeriodicOverlayDomain = "magnetic" | "airbox" | "mixed" | "unknown";
export type PeriodicOverlayStatus =
  | "valid"
  | "invalid"
  | "stale"
  | "unavailable";

export interface PeriodicOverlayPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface PeriodicFacePairGlyph {
  readonly destination: PeriodicOverlayPoint;
  readonly domain: PeriodicOverlayDomain;
  readonly id: string;
  readonly source: PeriodicOverlayPoint;
}

export interface PeriodicNodeLinkGlyph {
  readonly destination: PeriodicOverlayPoint;
  readonly id: string;
  readonly source: PeriodicOverlayPoint;
}

export interface PeriodicArrowGlyph {
  readonly destination: PeriodicOverlayPoint;
  readonly id: string;
  readonly source: PeriodicOverlayPoint;
}

export interface PeriodicUnpairedFaceGlyph {
  readonly domain: PeriodicOverlayDomain;
  readonly id: string;
  readonly vertices: readonly PeriodicOverlayPoint[];
}

export interface PeriodicOverlayModel {
  readonly arrows: readonly PeriodicArrowGlyph[];
  readonly certificateFingerprint: string | null;
  readonly counts: {
    readonly facePairs: number;
    readonly nodeLinks: number;
    readonly unpaired: number;
  };
  readonly facePairs: readonly PeriodicFacePairGlyph[];
  readonly fingerprint: string | null;
  readonly nodeLinks: readonly PeriodicNodeLinkGlyph[];
  readonly reason?: string;
  readonly status: PeriodicOverlayStatus;
  readonly unpaired: readonly PeriodicUnpairedFaceGlyph[];
}

export interface BuildPeriodicOverlayModelOptions {
  readonly currentCertificateFingerprint?: string | null;
  readonly currentMeshRevision?: number | string | null;
  readonly currentTopologyFingerprint?: string | null;
  readonly markerDomainById?: ReadonlyMap<number, PeriodicOverlayDomain>;
  readonly maxFacePairs?: number;
  readonly maxNodeLinks?: number;
  readonly maxUnpairedFaces?: number;
  readonly resource: MeshPeriodicPairsResource | null | undefined;
  readonly topology: DecodedTopology | null | undefined;
}

const EMPTY_COUNTS = { facePairs: 0, nodeLinks: 0, unpaired: 0 } as const;

function emptyModel(
  status: PeriodicOverlayStatus,
  fingerprint: string | null,
  certificateFingerprint: string | null,
  reason?: string,
): PeriodicOverlayModel {
  return {
    arrows: [],
    certificateFingerprint,
    counts: EMPTY_COUNTS,
    facePairs: [],
    fingerprint,
    nodeLinks: [],
    reason,
    status,
    unpaired: [],
  };
}

function point(topology: DecodedTopology, nodeId: number): PeriodicOverlayPoint {
  const offset = nodeId * 3;
  return {
    x: topology.positions[offset] ?? 0,
    y: topology.positions[offset + 1] ?? 0,
    z: topology.positions[offset + 2] ?? 0,
  };
}

function faceVertices(
  topology: DecodedTopology,
  faceId: number,
): readonly PeriodicOverlayPoint[] | null {
  const count = topologyFacetCount(topology);
  if (!Number.isInteger(faceId) || faceId < 0 || faceId >= count) {
    return null;
  }
  const vertices = topologyFacetNodes(topology, faceId);
  if (!vertices || vertices.length < 3) return null;
  if (vertices.some((nodeId) => nodeId == null || nodeId >= topology.nodeCount)) {
    return null;
  }
  return vertices.map((nodeId) => point(topology, nodeId!));
}

function topologyFacetCount(topology: DecodedTopology): number {
  if (
    topology.facetTypes &&
    topology.facetOffsets &&
    topology.facetNodes &&
    topology.facetOffsets.length === topology.facetTypes.length + 1
  ) {
    return topology.facetTypes.length;
  }
  return topology.boundaryFaceCount;
}

function topologyFacetNodes(
  topology: DecodedTopology,
  facet: number,
): readonly number[] | null {
  if (
    topology.facetTypes &&
    topology.facetOffsets &&
    topology.facetNodes &&
    topology.facetOffsets.length === topology.facetTypes.length + 1
  ) {
    const start = topology.facetOffsets[facet] ?? 0;
    const end = topology.facetOffsets[facet + 1] ?? start;
    return Array.from(topology.facetNodes.subarray(start, end));
  }
  const start = facet * 3;
  return start + 2 < topology.boundaryFaces.length
    ? Array.from(topology.boundaryFaces.subarray(start, start + 3))
    : null;
}

function centroid(vertices: readonly PeriodicOverlayPoint[]): PeriodicOverlayPoint {
  const sum = vertices.reduce(
    (accumulator, vertex) => ({
      x: accumulator.x + vertex.x,
      y: accumulator.y + vertex.y,
      z: accumulator.z + vertex.z,
    }),
    { x: 0, y: 0, z: 0 },
  );
  return {
    x: sum.x / vertices.length,
    y: sum.y / vertices.length,
    z: sum.z / vertices.length,
  };
}

function domainForPair(
  markerA: number,
  markerB: number,
  markerDomainById?: ReadonlyMap<number, PeriodicOverlayDomain>,
): PeriodicOverlayDomain {
  const domainA = markerDomainById?.get(markerA) ?? "unknown";
  const domainB = markerDomainById?.get(markerB) ?? "unknown";
  if (domainA !== "unknown" && domainB !== "unknown" && domainA !== domainB) {
    return "mixed";
  }
  return domainA !== "unknown" ? domainA : domainB;
}

function sameRevision(
  resourceRevision: number,
  currentRevision: number | string | null | undefined,
): boolean {
  return currentRevision == null || String(resourceRevision) === String(currentRevision);
}

export function buildPeriodicOverlayModel({
  currentCertificateFingerprint = null,
  currentMeshRevision = null,
  currentTopologyFingerprint = null,
  markerDomainById,
  maxFacePairs = 256,
  maxNodeLinks = 4096,
  maxUnpairedFaces = 512,
  resource,
  topology,
}: BuildPeriodicOverlayModelOptions): PeriodicOverlayModel {
  if (!resource || !topology) {
    return emptyModel("unavailable", null, null, "Periodic certificate or topology is unavailable.");
  }

  const certificateFingerprint = resource.certificate_fingerprint ?? null;
  const fingerprint = certificateFingerprint ?? resource.topology_fingerprint ?? null;
  if (resource.status !== "valid") {
    return emptyModel(
      resource.status === "stale" ? "stale" : "invalid",
      fingerprint,
      certificateFingerprint,
      `Periodic certificate status is ${resource.status ?? "unknown"}.`,
    );
  }
  if (
    !sameRevision(resource.revision, currentMeshRevision) ||
    (currentCertificateFingerprint != null &&
      certificateFingerprint !== currentCertificateFingerprint) ||
    (currentTopologyFingerprint != null &&
      resource.topology_fingerprint !== currentTopologyFingerprint)
  ) {
    return emptyModel(
      "stale",
      fingerprint,
      certificateFingerprint,
      "Periodic certificate does not match the current mesh revision or topology.",
    );
  }

  const facePairs: PeriodicFacePairGlyph[] = [];
  const nodeLinks: PeriodicNodeLinkGlyph[] = [];
  const arrows: PeriodicArrowGlyph[] = [];
  const pairedFaceIds = new Set<number>();

  for (const pair of resource.pairs.slice(0, Math.max(0, maxFacePairs))) {
    const pairFacePairs = pair.boundary_face_pairs ?? [];
    for (const [faceIndex, facePair] of pairFacePairs.entries()) {
      const sourceVertices = faceVertices(topology, facePair.face_a);
      const destinationVertices = faceVertices(topology, facePair.face_b);
      if (!sourceVertices || !destinationVertices) {
        return emptyModel(
          "invalid",
          fingerprint,
          certificateFingerprint,
          `Periodic certificate contains an out-of-range face pair for ${pair.pair_id}.`,
        );
      }
      pairedFaceIds.add(facePair.face_a);
      pairedFaceIds.add(facePair.face_b);
      const source = centroid(sourceVertices);
      const destination = centroid(destinationVertices);
      facePairs.push({
        destination,
        domain: domainForPair(pair.marker_a, pair.marker_b, markerDomainById),
        id: `${pair.pair_id}:face:${faceIndex}`,
        source,
      });
      arrows.push({
        destination,
        id: `${pair.pair_id}:arrow:${faceIndex}`,
        source,
      });
    }

    for (const [nodeIndex, nodePair] of (pair.node_pairs ?? [])
      .slice(0, Math.max(0, maxNodeLinks - nodeLinks.length))
      .entries()) {
      const [sourceId, destinationId] = nodePair;
      if (
        !Number.isInteger(sourceId) ||
        !Number.isInteger(destinationId) ||
        sourceId < 0 ||
        destinationId < 0 ||
        sourceId >= topology.nodeCount ||
        destinationId >= topology.nodeCount
      ) {
        return emptyModel(
          "invalid",
          fingerprint,
          certificateFingerprint,
          `Periodic certificate contains an out-of-range node pair for ${pair.pair_id}.`,
        );
      }
      nodeLinks.push({
        destination: point(topology, destinationId),
        id: `${pair.pair_id}:node:${nodeIndex}`,
        source: point(topology, sourceId),
      });
    }
  }

  const unpaired: PeriodicUnpairedFaceGlyph[] = [];
  for (
    let faceId = 0;
    faceId < topologyFacetCount(topology) && unpaired.length < Math.max(0, maxUnpairedFaces);
    faceId += 1
  ) {
    if (pairedFaceIds.has(faceId)) continue;
    const vertices = faceVertices(topology, faceId);
    if (!vertices) {
      return emptyModel(
        "invalid",
        fingerprint,
        certificateFingerprint,
        `Topology contains an invalid boundary face at index ${faceId}.`,
      );
    }
    const marker = topology.facetMarkers?.[faceId] ?? topology.boundaryMarkers[faceId];
    unpaired.push({
      domain: domainForPair(marker ?? 0, marker ?? 0, markerDomainById),
      id: `unpaired-face:${faceId}`,
      vertices,
    });
  }

  return {
    arrows,
    certificateFingerprint,
    counts: {
      facePairs: facePairs.length,
      nodeLinks: nodeLinks.length,
      unpaired: unpaired.length,
    },
    facePairs,
    fingerprint,
    nodeLinks,
    status: "valid",
    unpaired,
  };
}
