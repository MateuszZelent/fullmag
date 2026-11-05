import { describe, expect, it } from "vitest";

import { FMRM_INACTIVE_REGION_ID, type DecodedFieldVector } from "@/kernel/api/codecs";

import {
  buildFdmMultilayerAirboxFieldRequest,
  buildFdmMultilayerAirboxRegionIds,
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

  it("keys server-sampled Surface fields separately from Full", () => {
    const surface = buildFdmMultilayerAirboxFieldRequest(
      domain as never,
      1200,
      "H_demag",
      "surface",
    );
    expect(surface?.query).toEqual({
      component: "full",
      geometry_scope: "surface",
      max_samples: 1200,
      scope_id: "airbox",
      scope_kind: "airbox",
    });
    expect(surface?.requestId).toBe(
      "fdm-multilayer-airbox:H_demag:max_samples=1200:geometry_scope=surface",
    );
    expect(buildFdmMultilayerAirboxFieldRequest(domain as never, 1200, "H_demag", "full"))
      .toEqual(buildFdmMultilayerAirboxFieldRequest(domain as never, 1200));
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

  it("does not request fields or accept field buffers for geometry-only previews", () => {
    const geometryOnlyDomain = {
      ...domain,
      carrierFingerprint: null,
      geometryOnly: true,
    };
    expect(
      buildFdmMultilayerAirboxFieldRequest(geometryOnlyDomain as never, 1200),
    ).toBeNull();
    expect(
      shouldRequestFdmMultilayerAirboxField(
        {
          activeQuantityId: "H_demag",
          shaderVisible: true,
          vectorsVisible: true,
          visible: true,
        },
        "H_demag",
        geometryOnlyDomain as never,
      ),
    ).toBe(false);
    expect(
      resolveFdmMultilayerAirboxFieldVector(
        geometryOnlyDomain as never,
        field(),
      ),
    ).toBeNull();
    expect(
      shouldRequestFdmMultilayerAirboxField(
        {
          activeQuantityId: "H_demag",
          shaderVisible: true,
          vectorsVisible: true,
          visible: true,
        },
        "H_demag",
        { ...geometryOnlyDomain, geometryOnly: false } as never,
      ),
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
          grid: [2, 1, 1],
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

describe("FDM multilayer Airbox occupancy", () => {
  const air = FMRM_INACTIVE_REGION_ID;

  it("maps Airbox centres into half-open active native cells", () => {
    const target = {
      shape: [4, 1, 1],
      origin: [-0.5, 0, 0],
      spacing: [1, 1, 1],
      totalCells: 4,
    } as const;
    const layer = {
      domain: {
        shape: [2, 1, 1],
        origin: [0, 0, 0],
        spacing: [1, 1, 1],
        totalCells: 2,
        activeMaskPresent: true,
      },
      activeMask: Uint8Array.of(1, 0),
    } as const;
    expect(buildFdmMultilayerAirboxRegionIds(target, [layer])).toEqual(
      Uint32Array.of(0, air, air, air),
    );
    expect(buildFdmMultilayerAirboxRegionIds(target, [{
      ...layer,
      activeMask: Uint8Array.of(1, 1),
    }])).toEqual(Uint32Array.of(0, 0, air, air));
  });

  it("unions active native occupancy across different 3D pitches and origins", () => {
    const target = {
      shape: [4, 2, 2],
      origin: [0, -1, 0],
      spacing: [0.5, 1, 1],
      totalCells: 16,
    } as const;
    const coarse = {
      domain: {
        shape: [2, 1, 1],
        origin: [0, -1, 0],
        spacing: [1, 1, 2],
        totalCells: 2,
        activeMaskPresent: true,
      },
      activeMask: Uint8Array.of(1, 0),
    } as const;
    const dense = {
      domain: {
        shape: [1, 1, 1],
        origin: [1.5, 0, 1],
        spacing: [1, 1, 1],
        totalCells: 1,
        activeMaskPresent: false,
      },
      activeMask: null,
    } as const;
    const overlappingInactive = { ...coarse, activeMask: Uint8Array.of(0, 0) };
    expect(buildFdmMultilayerAirboxRegionIds(target, [coarse, dense, overlappingInactive]))
      .toEqual(Uint32Array.of(
        0, 0, air, air,
        air, air, air, air,
        0, 0, air, air,
        air, air, air, 0,
      ));
  });

  it("rejects unavailable native occupancy and inconsistent target cardinality", () => {
    const target = {
      shape: [2, 1, 1],
      origin: [0, 0, 0],
      spacing: [1, 1, 1],
      totalCells: 2,
    } as const;
    const domain = { ...target, activeMaskPresent: true };
    expect(buildFdmMultilayerAirboxRegionIds(target, [])).toBeNull();
    expect(buildFdmMultilayerAirboxRegionIds(target, [{ domain, activeMask: null }]))
      .toBeNull();
    expect(buildFdmMultilayerAirboxRegionIds(target, [{ domain, activeMask: Uint8Array.of(1) }]))
      .toBeNull();
    expect(buildFdmMultilayerAirboxRegionIds(
      { ...target, totalCells: 3 },
      [{ domain, activeMask: Uint8Array.of(1, 0) }],
    )).toBeNull();
  });
});
