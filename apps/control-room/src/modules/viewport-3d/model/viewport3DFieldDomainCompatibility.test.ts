import { describe, expect, it } from "vitest";

import {
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

  it("treats unsafe numeric domain generations as unknown", () => {
    expect(safeViewport3DDomainGenerationId(43)).toBe("43");
    expect(safeViewport3DDomainGenerationId(9007199254741001)).toBeNull();
  });
});
