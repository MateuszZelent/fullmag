import { describe, expect, it } from "vitest";

import {
  resolveTrustedViewport3DResponseDomainGenerationId,
  resolveViewport3DFieldDomainCompatibility,
  resolveViewport3DFieldVectorForDomain,
  safeViewport3DDomainGenerationId,
} from "./viewport3DFieldDomainCompatibility";

describe("resolveViewport3DFieldDomainCompatibility", () => {
  const domain = {
    domainGenerationId: "43",
    meshTopologyHash: "h",
    meshTopologyRevision: "7",
    pointCount: 4,
  };

  it("rejects FMVP v3 fields from another exact decimal domain generation", () => {
    expect(
      resolveViewport3DFieldDomainCompatibility({
        domain,
        field: {
          domainGenerationId: "42",
          formatVersion: 3,
          indexing: "full_domain",
          meshTopologyHash: "h",
          meshTopologyRevision: "7",
          pointCount: 4,
        },
      }),
    ).toMatchObject({
      reason: "domain-generation-mismatch",
      status: "mismatch",
    });
  });

  it("compares unsafe FMVP v3 domain generations as exact decimal strings", () => {
    expect(
      resolveViewport3DFieldDomainCompatibility({
        domain: { ...domain, domainGenerationId: "9007199254741001" },
        field: {
          domainGenerationId: "9007199254741000",
          formatVersion: 3,
          indexing: "full_domain",
          meshTopologyHash: "h",
          meshTopologyRevision: "7",
          pointCount: 4,
        },
      }),
    ).toMatchObject({
      reason: "domain-generation-mismatch",
      status: "mismatch",
    });
  });

  it("rejects FMVP v3 fields when a domain generation is unavailable", () => {
    expect(
      resolveViewport3DFieldDomainCompatibility({
        domain: { ...domain, domainGenerationId: null },
        field: {
          domainGenerationId: "43",
          formatVersion: 3,
          indexing: "full_domain",
          meshTopologyHash: "h",
          meshTopologyRevision: "7",
          pointCount: 4,
        },
      }),
    ).toMatchObject({
      reason: "domain-generation-unknown",
      status: "mismatch",
    });
  });

  it("keeps FMVP v2 explicitly degraded", () => {
    expect(
      resolveViewport3DFieldDomainCompatibility({
        domain,
        field: {
          formatVersion: 2,
          indexing: "full_domain",
          meshTopologyHash: "h",
          meshTopologyRevision: "7",
          pointCount: 4,
        },
      }),
    ).toMatchObject({ status: "degraded", reason: "fmvp-v2-legacy" });
  });

  it("accepts an FMVP v2 FDM field only when the response header identifies the current domain", () => {
    expect(
      resolveViewport3DFieldDomainCompatibility({
        domain: {
          discretization: "fdm",
          domainGenerationId: "fdm-1",
          meshTopologyHash: null,
          meshTopologyRevision: null,
          pointCount: 4,
        },
        field: {
          formatVersion: 2,
          indexing: "legacy_count_only",
          meshTopologyHash: null,
          meshTopologyRevision: null,
          pointCount: 4,
        },
        responseDomainGenerationId: "fdm-1",
      }),
    ).toEqual({ reason: "compatible", status: "compatible" });
  });

  it.each([
    [null, "domain-generation-unknown"],
    ["fdm-stale", "domain-generation-mismatch"],
  ] as const)(
    "rejects an FMVP v2 FDM field with response generation %s",
    (responseDomainGenerationId, reason) => {
      expect(
        resolveViewport3DFieldDomainCompatibility({
          domain: {
            discretization: "fdm",
            domainGenerationId: "fdm-1",
            meshTopologyHash: null,
            meshTopologyRevision: null,
            pointCount: 4,
          },
          field: {
            formatVersion: 2,
            indexing: "legacy_count_only",
            meshTopologyHash: null,
            meshTopologyRevision: null,
            pointCount: 4,
          },
          responseDomainGenerationId,
        }),
      ).toEqual({ reason, status: "mismatch" });
    },
  );

  it("matches a manifest sha256 fingerprint with the raw FMVP digest", () => {
    const digest = "72a6526603d5488bde1206de81d455638d624bdcd6209ef7638349de3cf4fcdc";

    expect(
      resolveViewport3DFieldDomainCompatibility({
        domain: { ...domain, meshTopologyHash: `sha256:${digest}` },
        field: {
          domainGenerationId: "43",
          formatVersion: 3,
          indexing: "sampled_node_indices",
          meshTopologyHash: digest,
          meshTopologyRevision: "7",
          pointCount: 4,
        },
      }),
    ).toEqual({ reason: "compatible", status: "compatible" });
  });

  it("does not pass an FMVP v3 field into a different FDM generation", () => {
    const field = {
      domainGenerationId: "generation-a",
      formatVersion: 3,
      indexing: "full_domain",
      meshTopologyHash: null,
      meshTopologyRevision: null,
      pointCount: 4,
    } as never;

    expect(
      resolveViewport3DFieldVectorForDomain({
        domain: { ...domain, domainGenerationId: "generation-b" },
        fieldVector: field,
      }),
    ).toBeNull();
  });

  it("fails closed for a downsampled legacy FDM payload without cell indexing", () => {
    expect(
      resolveViewport3DFieldDomainCompatibility({
        domain: {
          discretization: "fdm",
          domainGenerationId: "fdm-1",
          meshTopologyHash: null,
          meshTopologyRevision: null,
          pointCount: 4,
        },
        field: {
          formatVersion: 2,
          indexing: "legacy_count_only",
          meshTopologyHash: null,
          meshTopologyRevision: null,
          pointCount: 2,
        },
        responseDomainGenerationId: "fdm-1",
      }),
    ).toMatchObject({
      reason: "point-count-mismatch",
      status: "mismatch",
    });
  });

  it("accepts an explicitly indexed partial FDM payload", () => {
    expect(
      resolveViewport3DFieldDomainCompatibility({
        domain: {
          discretization: "fdm",
          domainGenerationId: "fdm-1",
          meshTopologyHash: null,
          meshTopologyRevision: null,
          pointCount: 4,
        },
        field: {
          domainGenerationId: "fdm-1",
          formatVersion: 3,
          indexing: "sampled_node_indices",
          meshTopologyHash: null,
          meshTopologyRevision: null,
          nodeIndices: Uint32Array.from([3, 1]),
          pointCount: 2,
        },
      }),
    ).toMatchObject({ status: "compatible" });
  });

  it("accepts an FDM FMVP v3 carrier hash only when it matches the current FMRM grid", () => {
    const gridFingerprint = "72a6526603d5488bde1206de81d455638d624bdcd6209ef7638349de3cf4fcdc";
    expect(
      resolveViewport3DFieldDomainCompatibility({
        domain: {
          discretization: "fdm",
          domainGenerationId: "fdm-1",
          meshTopologyHash: `sha256:${gridFingerprint}`,
          meshTopologyRevision: null,
          pointCount: 4,
        },
        field: {
          domainGenerationId: "fdm-1",
          formatVersion: 3,
          indexing: "explicit_node_indices",
          meshTopologyHash: gridFingerprint,
          meshTopologyRevision: "1",
          nodeIndices: Uint32Array.from([0, 2]),
          pointCount: 2,
        },
      }),
    ).toEqual({ reason: "compatible", status: "compatible" });
  });

  it("fails closed when an FDM FMVP v3 carrier hash disagrees with the current FMRM grid", () => {
    expect(
      resolveViewport3DFieldDomainCompatibility({
        domain: {
          discretization: "fdm",
          domainGenerationId: "fdm-1",
          meshTopologyHash: "a".repeat(64),
          meshTopologyRevision: null,
          pointCount: 4,
        },
        field: {
          domainGenerationId: "fdm-1",
          formatVersion: 3,
          indexing: "explicit_node_indices",
          meshTopologyHash: "b".repeat(64),
          meshTopologyRevision: "1",
          nodeIndices: Uint32Array.from([0, 2]),
          pointCount: 2,
        },
      }),
    ).toMatchObject({
      reason: "mesh-topology-hash-mismatch",
      status: "mismatch",
    });
  });

  it("fails closed for scoped FDM FMVP v3 when the FMRM carrier is unavailable", () => {
    expect(
      resolveViewport3DFieldDomainCompatibility({
        domain: {
          discretization: "fdm",
          domainGenerationId: "fdm-1",
          meshTopologyHash: null,
          meshTopologyRevision: null,
          pointCount: 4,
        },
        field: {
          domainGenerationId: "fdm-1",
          formatVersion: 3,
          indexing: "explicit_node_indices",
          meshTopologyHash: "b".repeat(64),
          meshTopologyRevision: "1",
          nodeIndices: Uint32Array.from([0, 2]),
          pointCount: 2,
        },
      }),
    ).toMatchObject({
      reason: "fdm-carrier-identity-unknown",
      status: "mismatch",
    });
  });

  it("keeps FEM legacy v2 point-count compatibility unchanged", () => {
    expect(
      resolveViewport3DFieldDomainCompatibility({
        domain,
        field: {
          formatVersion: 2,
          indexing: "legacy_count_only",
          meshTopologyHash: "h",
          meshTopologyRevision: "7",
          pointCount: 2,
        },
      }),
    ).toMatchObject({ status: "degraded", reason: "fmvp-v2-legacy" });
  });

  it.each(["explicit_node_indices", "sampled_node_indices"] as const)(
    "rejects duplicate node indices in a scoped FEM field using %s",
    (indexing) => {
      expect(
        resolveViewport3DFieldDomainCompatibility({
          domain: {
            ...domain,
            discretization: "fem",
          },
          field: {
            domainGenerationId: "43",
            formatVersion: 3,
            indexing,
            meshTopologyHash: "h",
            meshTopologyRevision: "7",
            nodeIndices: Uint32Array.from([1, 1]),
            pointCount: 2,
          },
        }),
      ).toMatchObject({
        reason: "duplicate-node-index",
        status: "mismatch",
      });
    },
  );

  it("does not pass a downsampled legacy FDM vector into the renderer", () => {
    expect(
      resolveViewport3DFieldVectorForDomain({
        domain: {
          discretization: "fdm",
          domainGenerationId: "fdm-1",
          meshTopologyHash: null,
          meshTopologyRevision: null,
          pointCount: 4,
        },
        fieldVector: {
          dtype: "float64",
          formatVersion: 2,
          grid: [2, 1, 1],
          indexing: "legacy_count_only",
          nComp: 3,
          pointCount: 2,
          quantityId: "m",
          valueCount: 6,
          values: new Float64Array(6),
        },
      }),
    ).toBeNull();
  });

  it("treats unsafe numeric domain generations as unknown", () => {
    expect(safeViewport3DDomainGenerationId(43)).toBe("43");
    expect(safeViewport3DDomainGenerationId(9007199254741001)).toBeNull();
  });
});

describe("resolveTrustedViewport3DResponseDomainGenerationId", () => {
  const field = {
    domainGenerationId: null,
    formatVersion: 2,
  } as const;

  it("trusts the v2 response generation when all other response identities match", () => {
    expect(
      resolveTrustedViewport3DResponseDomainGenerationId(field, {
        domainGenerationId: "fdm-7",
        identityIssues: [
          {
            field: "domainGenerationId",
            headerValue: "fdm-7",
            payloadValue: null,
          },
        ],
      }),
    ).toBe("fdm-7");
  });

  it("rejects the response generation when any other response identity disagrees", () => {
    expect(
      resolveTrustedViewport3DResponseDomainGenerationId(field, {
        domainGenerationId: "fdm-7",
        identityIssues: [
          { field: "pointCount", headerValue: 8, payloadValue: 4 },
          {
            field: "domainGenerationId",
            headerValue: "fdm-7",
            payloadValue: null,
          },
        ],
      }),
    ).toBeNull();
  });

  it("uses the payload identity for FMVP v3", () => {
    expect(
      resolveTrustedViewport3DResponseDomainGenerationId(
        { domainGenerationId: "fdm-8", formatVersion: 3 },
        null,
      ),
    ).toBe("fdm-8");
  });
});
