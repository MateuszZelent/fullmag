import { describe, expect, it } from "vitest";

import { FMRM_INACTIVE_REGION_ID } from "@/kernel/api/codecs";

import {
  resolveVisualizationVectorCapacityDescriptor,
  type VisualizationVectorCapacitySource,
} from "./visualizationVectorCapacity";

const target = (id: string, kind: "airbox" | "fdm-domain" = "fdm-domain") => ({
  id,
  kind,
});

describe("visualization vector capacity", () => {
  it("derives single-grid FDM Airbox capacity from inactive membership cells", () => {
    const source: VisualizationVectorCapacitySource = {
      kind: "fdm",
      carrierId: "fdm:grid-7",
      domainGenerationId: "generation-7",
      gridFingerprint: "grid-7",
      shape: [199_680, 1, 1],
      activeCellCount: 1_600,
      inactiveCellCount: 198_080,
      realizedRegionIds: null,
      revision: "mesh-3:membership-4",
    };

    expect(
      resolveVisualizationVectorCapacityDescriptor({
        source,
        target: target("airbox", "airbox"),
        geometryScope: "full",
      }),
    ).toMatchObject({
      targetId: "airbox",
      carrierId: "fdm:grid-7",
      anchorKind: "cell",
      fullCount: 198_080,
      surfaceCount: 198_080,
      exact: true,
      generation: "generation-7",
      revision: "mesh-3:membership-4",
    });
  });

  it("uses the shared FDM cell-neighbour rule so Surface can differ from Full", () => {
    const shape: [number, number, number] = [5, 5, 5];
    const realizedRegionIds = new Uint32Array(125);
    realizedRegionIds.fill(FMRM_INACTIVE_REGION_ID);
    realizedRegionIds[62] = 1;
    const source: VisualizationVectorCapacitySource = {
      kind: "fdm",
      carrierId: "fdm:grid-surface",
      domainGenerationId: "generation-surface",
      gridFingerprint: "grid-surface",
      shape,
      activeCellCount: 1,
      inactiveCellCount: 124,
      realizedRegionIds,
      revision: 8,
    };

    const descriptor = resolveVisualizationVectorCapacityDescriptor({
      source,
      target: target("airbox", "airbox"),
      geometryScope: "full",
    });
    const surface = resolveVisualizationVectorCapacityDescriptor({
      source,
      target: target("airbox", "airbox"),
      geometryScope: "surface",
    });

    expect(descriptor?.fullCount).toBe(124);
    expect(surface?.surfaceCount).toBeLessThan(descriptor?.fullCount ?? 0);
    expect(surface?.surfaceCount).toBeGreaterThan(0);
  });

  it("uses native layer counts and identity instead of the common-grid shape", () => {
    const source: VisualizationVectorCapacitySource = {
      kind: "fdm-native-layer",
      carrierId: "fdm-native-layer:layer%3Atop",
      domainGenerationId: "generation-native",
      gridFingerprint: "native-grid-top",
      shape: [4, 4, 4],
      activeCellCount: 10,
      inactiveCellCount: 54,
      activeMask: Uint8Array.from({ length: 64 }, (_, index) => (index < 10 ? 1 : 0)),
      revision: 12,
    };

    expect(
      resolveVisualizationVectorCapacityDescriptor({
        source,
        target: { id: source.carrierId, kind: "fdm-native-layer" },
        geometryScope: "full",
      }),
    ).toMatchObject({
      fullCount: 10,
      anchorKind: "cell",
      carrierId: source.carrierId,
      generation: "generation-native",
      revision: 12,
    });
  });

  it("counts FEM anchors as a union of target mesh-part nodes", () => {
    const source: VisualizationVectorCapacitySource = {
      kind: "fem",
      carrierId: "mesh-1",
      generation: "mesh-generation-1",
      revision: 4,
      topologyHash: "topology-1",
      fullNodeIndices: [1, 2, 3, 3, 4],
      surfaceNodeIndices: [1, 2, 4],
    };

    expect(
      resolveVisualizationVectorCapacityDescriptor({
        source,
        target: { id: "object:film", kind: "object" },
        geometryScope: "full",
      }),
    ).toMatchObject({
      anchorKind: "node",
      fullCount: 4,
      surfaceCount: 3,
      exact: true,
      carrierId: "mesh-1",
      generation: "mesh-generation-1",
      revision: 4,
      topologyHash: "topology-1",
    });
  });
});
