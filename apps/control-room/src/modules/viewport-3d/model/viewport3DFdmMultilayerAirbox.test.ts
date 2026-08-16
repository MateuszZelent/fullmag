import { describe, expect, it } from "vitest";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

import {
  buildFdmMultilayerAirboxFieldRequest,
  resolveFdmMultilayerAirboxFieldVector,
  shouldRequestFdmMultilayerAirboxField,
} from "./viewport3DFdmMultilayerAirbox";

const domain = {
  carrierFingerprint:
    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  domainGenerationId: "generation-7",
  shape: [2, 2, 1] as const,
  totalCells: 4,
};

function field(overrides: Partial<DecodedFieldVector> = {}): DecodedFieldVector {
  return {
    domainGenerationId: "generation-7",
    formatVersion: 3,
    grid: [2, 2, 1],
    indexing: "explicit_node_indices",
    meshTopologyHash: domain.carrierFingerprint,
    meshTopologyRevision: null,
    nComp: 3,
    nodeIndices: new Uint32Array([0, 1, 2, 3]),
    pointCount: 4,
    quantityId: "H_demag",
    scopeId: "airbox",
    scopeKind: "airbox",
    valueCount: 12,
    values: new Float64Array(12),
    ...overrides,
  } as DecodedFieldVector;
}

describe("FDM multilayer Airbox target field", () => {
  it("bounds vectors-only transport with max_samples on the canonical Airbox scope", () => {
    expect(buildFdmMultilayerAirboxFieldRequest(domain as never, 1200)).toEqual({
      consumers: ["viewport-3d:fdm-multilayer-airbox"],
      quantityId: "H_demag",
      query: {
        component: "full",
        max_samples: 1200,
        scope_id: "airbox",
        scope_kind: "airbox",
      },
      requestId: "fdm-multilayer-airbox:H_demag:max_samples=1200",
    });
  });

  it("demands H_demag for scalar or vector rendering, never for unavailable H_eff", () => {
    expect(
      shouldRequestFdmMultilayerAirboxField({
        activeQuantityId: "H_demag",
        shaderVisible: true,
        vectorsVisible: false,
        visible: true,
      }),
    ).toBe(true);
    expect(
      shouldRequestFdmMultilayerAirboxField({
        activeQuantityId: "H_demag",
        shaderVisible: false,
        vectorsVisible: true,
        visible: true,
      }),
    ).toBe(true);
    expect(
      shouldRequestFdmMultilayerAirboxField({
        activeQuantityId: "H_eff",
        shaderVisible: true,
        vectorsVisible: true,
        visible: true,
      }),
    ).toBe(false);
  });

  it("accepts a matching FMVP v3 target grid with explicit index coverage", () => {
    expect(resolveFdmMultilayerAirboxFieldVector(domain as never, field())).toBeTruthy();
  });

  it("accepts a sampled FMVP v3 payload with explicit cell ordinals", () => {
    expect(
      resolveFdmMultilayerAirboxFieldVector(
        domain as never,
        field({
          indexing: "sampled_node_indices",
          nodeIndices: new Uint32Array([1, 3]),
          pointCount: 2,
          valueCount: 6,
          values: new Float64Array(6),
        }),
      ),
    ).toBeTruthy();
  });

  it.each([
    ["wrong quantity", field({ quantityId: "H_eff" })],
    ["wrong scope", field({ scopeId: "layer:a", scopeKind: "layer" })],
    ["wrong carrier fingerprint", field({ meshTopologyHash: "sha256:wrong" })],
    ["wrong target grid", field({ grid: [4, 1, 1] })],
    ["incomplete explicit indices", field({ nodeIndices: new Uint32Array([0, 1, 2]) })],
  ] as const)("fails closed for %s", (_label, candidate) => {
    expect(resolveFdmMultilayerAirboxFieldVector(domain as never, candidate)).toBeNull();
  });

  it.each(["", "   ", null])(
    "fails closed for malformed FMVP domain generation %j",
    (domainGenerationId) => {
      expect(
        resolveFdmMultilayerAirboxFieldVector(
          domain as never,
          field({ domainGenerationId: domainGenerationId as never }),
        ),
      ).toBeNull();
    },
  );
});
