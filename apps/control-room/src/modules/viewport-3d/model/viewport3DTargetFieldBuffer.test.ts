import { describe, expect, it } from "vitest";

import type { DecodedFieldVector } from "@/kernel/api/codecs";
import type { FieldVectorResponseMetadata } from "@/kernel/api/apiTypes";
import { collectFieldVectorIdentityIssues } from "@/kernel/api/ControlRoomApi";
import {
  canonicalFieldVectorQuery,
  fieldVectorResourceKey,
  serializeCanonicalFieldVectorResourceKey,
} from "@/kernel/api/fieldQueryIdentity";

import {
  buildViewport3DTargetFieldBuffer as buildViewport3DTargetFieldBufferWithResourceKey,
  resolveViewport3DTargetFieldInput,
  viewport3DTargetFieldBufferCanServeSurface,
  viewport3DTargetFieldBufferCanServeVectors,
} from "./viewport3DTargetFieldBuffer";
import { resolveTrustedViewport3DResponseDomainGenerationId } from "./viewport3DFieldDomainCompatibility";

type TargetFieldBufferOptions = Parameters<
  typeof buildViewport3DTargetFieldBufferWithResourceKey
>[0];

function buildViewport3DTargetFieldBuffer(
  options: Omit<TargetFieldBufferOptions, "resourceKey"> & {
    resourceKey?: string | null;
  },
) {
  return buildViewport3DTargetFieldBufferWithResourceKey({
    ...options,
    resourceKey:
      options.resourceKey ??
      serializeCanonicalFieldVectorResourceKey(
        canonicalFieldVectorQuery(options.fieldVector.quantityId, options.query),
      ),
  });
}

function vectorFixture(overrides: Partial<DecodedFieldVector> = {}): DecodedFieldVector {
  const nComp = overrides.nComp ?? 3;
  const pointCount = overrides.pointCount ?? 4;
  return {
    dtype: "float64",
    grid: [pointCount, 1, 1],
    nComp,
    pointCount,
    quantityId: "m",
    valueCount: pointCount * nComp,
    values: new Float64Array(pointCount * nComp),
    ...overrides,
  };
}

function responseMetadataFixture(
  overrides: Partial<FieldVectorResponseMetadata> = {},
): FieldVectorResponseMetadata {
  return {
    component: "full",
    domainGenerationId: "fdm-1",
    encoding: "FMVP;version=3",
    fieldIndexing: "full_domain",
    fieldRevision: "7",
    identityIssues: [],
    meshTopologyHash: null,
    nComp: 3,
    nodeIndexCount: 0,
    pointCount: 4,
    quantityId: "m",
    scopeId: "sample",
    scopeKind: "object",
    snapshotId: "snapshot-1",
    valueCount: 12,
    ...overrides,
  };
}

describe("viewport3DTargetFieldBuffer", () => {
  it.each([
    ["object", "sample", undefined, "object:sample"],
    ["region", "shared", "sample", "region:sample:shared"],
    ["airbox", "airbox", undefined, "fdm-universe-outside-support"],
  ] as const)(
    "fails closed for a nonsynthetic FMVP v2 %s response without trusted metadata",
    (scopeKind, scopeId, ownerObjectId, targetId) => {
      const buffer = buildViewport3DTargetFieldBuffer({
        domain: {
          discretization: "fdm",
          domainGenerationId: "fdm-1",
          gridShape: [4, 1, 1],
          meshTopologyHash: null,
          meshTopologyRevision: null,
          pointCount: 4,
        },
        fieldVector: vectorFixture({
          formatVersion: 2,
          indexing: "legacy_count_only",
        }),
        query: {
          component: "full",
          owner_object_id: ownerObjectId,
          scope_id: scopeId,
          scope_kind: scopeKind,
        },
        responseDomainGenerationId: "fdm-1",
        responseMetadata: null,
        targetIds: [targetId],
      });

      expect(buffer.requestIdentityCompatible).toBe(false);
      expect(
        viewport3DTargetFieldBufferCanServeSurface(buffer, "orientation", "m"),
      ).toBe(false);
      expect(viewport3DTargetFieldBufferCanServeVectors(buffer, "m")).toBe(false);
    },
  );

  it.each([
    ["cross-scope", { scopeId: "other", scopeKind: "object" }],
    ["cross-component", { component: "x" }],
    ["cross-snapshot", { snapshotId: "snapshot-2" }],
  ] as const)("fails closed for a v2 %s response identity", (_name, metadata) => {
    const buffer = buildViewport3DTargetFieldBuffer({
      domain: {
        discretization: "fdm",
        domainGenerationId: "fdm-1",
        meshTopologyHash: "a".repeat(64),
        meshTopologyRevision: null,
        pointCount: 4,
      },
      fieldVector: vectorFixture({
        formatVersion: 2,
        indexing: "legacy_count_only",
      }),
      query: {
        component: "full",
        scope_id: "sample",
        scope_kind: "object",
        snapshot_id: "snapshot-1",
      },
      responseDomainGenerationId: "fdm-1",
      responseMetadata: responseMetadataFixture({
        encoding: "FMVP;version=2",
        ...metadata,
      }),
      targetIds: ["object:sample"],
    });

    expect(buffer.requestIdentityCompatible).toBe(false);
    expect(viewport3DTargetFieldBufferCanServeVectors(buffer, "m")).toBe(false);
  });

  it.each([
    "component",
    "domainGenerationId",
    "encoding",
    "fieldRevision",
    "nComp",
    "pointCount",
    "quantityId",
    "scopeId",
    "scopeKind",
    "valueCount",
  ] as const)(
    "fails closed for incomplete trusted FMVP v2 metadata without %s",
    (missingField) => {
      const buffer = buildViewport3DTargetFieldBuffer({
        domain: {
          discretization: "fdm",
          domainGenerationId: "fdm-1",
          gridShape: [4, 1, 1],
          meshTopologyHash: null,
          meshTopologyRevision: null,
          pointCount: 4,
        },
        fieldVector: vectorFixture({
          formatVersion: 2,
          indexing: "legacy_count_only",
        }),
        query: {
          component: "full",
          scope_id: "sample",
          scope_kind: "object",
          snapshot_id: "snapshot-1",
        },
        responseDomainGenerationId: "fdm-1",
        responseMetadata: responseMetadataFixture({ [missingField]: null }),
        targetIds: ["object:sample"],
      });

      expect(buffer.requestIdentityCompatible).toBe(false);
    },
  );

  it("uses decoded v3 scope identity and rejects a cross-scope response", () => {
    const buffer = buildViewport3DTargetFieldBuffer({
      domain: {
        discretization: "fdm",
        domainGenerationId: "fdm-1",
        meshTopologyHash: null,
        meshTopologyRevision: null,
        pointCount: 2,
      },
      fieldVector: vectorFixture({
        domainGenerationId: "fdm-1",
        formatVersion: 3,
        grid: [2, 1, 1],
        indexing: "explicit_node_indices",
        meshTopologyHash: "a".repeat(64),
        nodeIndices: Uint32Array.from([0, 1]),
        pointCount: 2,
        scopeId: "airbox",
        scopeKind: "airbox",
        valueCount: 6,
        values: new Float64Array(6),
      }),
      query: { component: "full", scope_id: "sample", scope_kind: "object" },
      responseMetadata: responseMetadataFixture(),
      targetIds: ["object:sample"],
    });

    expect(buffer.requestIdentityCompatible).toBe(false);
  });

  it.each([
    ["object", "sample"],
    ["airbox", "airbox"],
  ] as const)("accepts an exact v3 %s identity", (scopeKind, scopeId) => {
    const buffer = buildViewport3DTargetFieldBuffer({
      domain: {
        discretization: "fdm",
        domainGenerationId: "fdm-1",
        meshTopologyHash: "a".repeat(64),
        meshTopologyRevision: null,
        pointCount: 2,
      },
      fieldVector: vectorFixture({
        domainGenerationId: "fdm-1",
        formatVersion: 3,
        grid: [2, 1, 1],
        indexing: "explicit_node_indices",
        meshTopologyHash: "a".repeat(64),
        nodeIndices: Uint32Array.from([0, 1]),
        pointCount: 2,
        scopeId,
        scopeKind,
        valueCount: 6,
        values: new Float64Array(6),
      }),
      query: {
        component: "full",
        scope_id: scopeId,
        scope_kind: scopeKind,
        snapshot_id: "snapshot-1",
      },
      responseMetadata: responseMetadataFixture({ scopeId, scopeKind }),
      targetIds: [scopeKind === "object" ? `object:${scopeId}` : scopeId],
    });

    expect(buffer.requestIdentityCompatible).toBe(true);
    expect(viewport3DTargetFieldBufferCanServeVectors(buffer, "m")).toBe(true);
  });

  it.each([
    ["object", "sample", undefined, "sample"],
    ["region", "shared", "sample", "region:sample:shared"],
    ["airbox", "airbox", undefined, "airbox"],
  ] as const)("accepts exact trusted v2 %s response metadata", (
    scopeKind,
    scopeId,
    ownerObjectId,
    responseScopeId,
  ) => {
    const fieldVector = vectorFixture({
      formatVersion: 2,
      indexing: "legacy_count_only",
    });
    const responseMetadata = responseMetadataFixture({
      encoding: "FMVP;version=2",
      scopeId: responseScopeId,
      scopeKind,
    });
    responseMetadata.identityIssues = collectFieldVectorIdentityIssues(
      fieldVector,
      responseMetadata,
    );
    const buffer = buildViewport3DTargetFieldBuffer({
      domain: {
        discretization: "fdm",
        domainGenerationId: "fdm-1",
        meshTopologyHash: null,
        meshTopologyRevision: null,
        pointCount: 4,
      },
      fieldVector,
      query: {
        component: "full",
        owner_object_id: ownerObjectId,
        scope_id: scopeId,
        scope_kind: scopeKind,
        snapshot_id: "snapshot-1",
      },
      responseDomainGenerationId:
        resolveTrustedViewport3DResponseDomainGenerationId(
          fieldVector,
          responseMetadata,
        ),
      responseMetadata,
      targetIds: [
        scopeKind === "object"
          ? `object:${scopeId}`
          : scopeKind === "region"
            ? responseScopeId
            : scopeId,
      ],
    });

    expect(buffer.requestIdentityCompatible).toBe(true);
    expect(viewport3DTargetFieldBufferCanServeVectors(buffer, "m")).toBe(true);
  });

  it("accepts a canonical FMVP v3 Airbox identity when scope_id was omitted", () => {
    const meshTopologyHash = "a".repeat(64);
    const buffer = buildViewport3DTargetFieldBuffer({
      domain: {
        discretization: "fdm",
        domainGenerationId: "fdm-1",
        gridShape: [4, 1, 1],
        meshTopologyHash,
        meshTopologyRevision: null,
        pointCount: 4,
      },
      fieldVector: vectorFixture({
        domainGenerationId: "fdm-1",
        formatVersion: 3,
        grid: [2, 1, 1],
        indexing: "explicit_node_indices",
        meshTopologyHash,
        nodeIndices: Uint32Array.from([2, 3]),
        pointCount: 2,
        quantityId: "H_demag",
        scopeId: "airbox",
        scopeKind: "airbox",
        valueCount: 6,
        values: new Float64Array(6),
      }),
      query: {
        component: "full",
        max_samples: 1200,
        scope_kind: "airbox",
      },
      responseDomainGenerationId: "fdm-1",
      responseMetadata: responseMetadataFixture({
        domainGenerationId: "fdm-1",
        encoding: "FMVP;version=3",
        fieldIndexing: "explicit_node_indices",
        meshTopologyHash,
        nComp: 3,
        nodeIndexCount: 2,
        pointCount: 2,
        quantityId: "H_demag",
        scopeId: "airbox",
        scopeKind: "airbox",
        snapshotId: null,
        valueCount: 6,
      }),
      targetIds: ["fdm-universe-outside-support"],
    });

    expect(buffer.requestIdentityCompatible).toBe(true);
    expect(buffer.scopeId).toBe("airbox");
    expect(viewport3DTargetFieldBufferCanServeVectors(buffer, "H_demag")).toBe(
      true,
    );
  });

  it("rejects a noncanonical FMVP v3 Airbox identity when scope_id was omitted", () => {
    const buffer = buildViewport3DTargetFieldBuffer({
      fieldVector: vectorFixture({
        domainGenerationId: "fdm-1",
        formatVersion: 3,
        indexing: "explicit_node_indices",
        meshTopologyHash: "a".repeat(64),
        nodeIndices: Uint32Array.from([2, 3]),
        pointCount: 2,
        quantityId: "H_demag",
        scopeId: "other-airbox",
        scopeKind: "airbox",
        valueCount: 6,
        values: new Float64Array(6),
      }),
      query: {
        component: "full",
        max_samples: 1200,
        scope_kind: "airbox",
      },
      responseMetadata: responseMetadataFixture({
        quantityId: "H_demag",
        scopeId: "other-airbox",
        scopeKind: "airbox",
        snapshotId: null,
      }),
      targetIds: ["fdm-universe-outside-support"],
    });

    expect(buffer.requestIdentityCompatible).toBe(false);
    expect(viewport3DTargetFieldBufferCanServeVectors(buffer, "H_demag")).toBe(
      false,
    );
  });

  it("rejects a decoded FMVP v3 scope that does not match the request", () => {
    const buffer = buildViewport3DTargetFieldBuffer({
      fieldVector: vectorFixture({
        formatVersion: 3,
        indexing: "sampled_node_indices",
        meshTopologyHash: "mesh-1",
        nodeIndices: new Uint32Array([0, 1, 2, 3]),
        scopeId: "part:wrong",
        scopeKind: "part",
      }),
      query: {
        component: "full",
        max_samples: 4,
        scope_id: "part:__air__",
        scope_kind: "airbox",
      },
      targetIds: ["part:__air__"],
    });

    expect(buffer.requestIdentityCompatible).toBe(false);
    expect(buffer.scopeKind).toBe("part");
    expect(buffer.scopeId).toBe("part:wrong");
    expect(viewport3DTargetFieldBufferCanServeVectors(buffer, "m")).toBe(false);
  });

  it.each(["region", "layer"] as const)(
    "preserves the %s scope kind from a scoped FDM FMVP v3 payload",
    (scopeKind) => {
      const scopeId = scopeKind === "region" ? "region:body:shared" : "layer-a";
      const buffer = buildViewport3DTargetFieldBuffer({
        domain: {
          discretization: "fdm",
          domainGenerationId: "fdm-1",
          meshTopologyHash: "a".repeat(64),
          meshTopologyRevision: null,
          pointCount: 4,
        },
        fieldVector: vectorFixture({
          domainGenerationId: "fdm-1",
          formatVersion: 3,
          indexing: "explicit_node_indices",
          meshTopologyHash: "a".repeat(64),
          meshTopologyRevision: "1",
          nodeIndices: Uint32Array.from([0, 1]),
          pointCount: 2,
          scopeId,
          scopeKind,
        }),
        query: {
          component: "full",
          owner_object_id: scopeKind === "region" ? "body" : undefined,
          scope_id: scopeKind === "region" ? "shared" : scopeId,
          scope_kind: scopeKind,
        },
        targetIds: [scopeId],
      });

      expect(buffer.scopeKind).toBe(scopeKind);
      expect(buffer.scopeId).toBe(scopeId);
      expect(buffer.domainCompatibility.status).toBe("compatible");
    },
  );

  it("classifies unsampled full vectors as complete full-vector buffers", () => {
    const fieldVector = vectorFixture();
    const buffer = buildViewport3DTargetFieldBuffer({
      fieldRevision: "field-1",
      fieldVector,
      query: {
        component: "full",
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
      topologyRevision: "topology-1",
    });

    expect(buffer.capability).toBe("full-vector-complete");
    expect(buffer.componentCount).toBe(3);
    expect(buffer.complete).toBe(true);
    expect(buffer.requestId).toContain("component=full");
    expect(buffer.requestId).toContain("quantity=m");
    expect(buffer.requestId).toContain("scope_id=part-a");
    expect(buffer.requestId).toContain("scope_kind=part");
    expect(buffer.resourceKey).toBe(
      fieldVectorResourceKey("m", {
        component: "full",
        scope_id: "part-a",
        scope_kind: "part",
      }),
    );
    expect(buffer.resourceKey).not.toBe(buffer.requestId);
    expect(buffer.sampled).toBe(false);
    expect(buffer.values).toBe(fieldVector.values);
    expect(buffer.vectorComponentCount).toBe(buffer.componentCount);
    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "orientation"))
      .toBe(true);
    expect(viewport3DTargetFieldBufferCanServeVectors(buffer)).toBe(true);
  });

  it("keeps canonical resource identity stable independently from planner query ordering", () => {
    const fieldVector = vectorFixture({ quantityId: "h_eff" });
    const first = buildViewport3DTargetFieldBuffer({
      fieldVector,
      query: {
        scope_kind: "object",
        max_samples: 32,
        component: "x",
        scope_id: "object:sample",
      },
      targetIds: ["object:sample"],
    });
    const second = buildViewport3DTargetFieldBuffer({
      fieldVector,
      query: {
        component: "x",
        max_samples: 32,
        scope_id: "sample",
        scope_kind: "object",
      },
      targetIds: ["object:sample"],
    });

    expect(first.resourceKey).toBe(
      fieldVectorResourceKey("H_eff", {
        component: "x",
        max_samples: 32,
        scope_id: "sample",
        scope_kind: "object",
      }),
    );
    expect(second.resourceKey).toBe(first.resourceKey);
    expect(first.requestId).not.toBe(first.resourceKey);
  });

  it("keeps the requested cache identity when decoded payload identity disagrees", () => {
    const requestedResourceKey = fieldVectorResourceKey("H_eff", {
      component: "full",
      scope_kind: "full",
    });
    const buffer = buildViewport3DTargetFieldBuffer({
      fieldVector: vectorFixture({ quantityId: "m" }),
      query: { component: "full", scope_kind: "full" },
      resourceKey: requestedResourceKey,
      targetIds: ["full"],
    });

    expect(buffer.resourceKey).toBe(requestedResourceKey);
    expect(buffer.quantityId).toBe("m");
  });

  it("allows sampled full vectors for glyphs but not surface shaders", () => {
    const buffer = buildViewport3DTargetFieldBuffer({
      fieldVector: vectorFixture({
        indexing: "sampled_node_indices",
        meshTopologyHash: "hash-1",
        nodeIndices: new Uint32Array([0, 2, 4, 6]),
      }),
      query: {
        component: "full",
        max_samples: 128,
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
    });

    expect(buffer.capability).toBe("full-vector-sampled");
    expect(buffer.indexing).toBe("sampled_node_indices");
    expect(buffer.meshTopologyHash).toBe("hash-1");
    expect(buffer.nodeIndices).toEqual(new Uint32Array([0, 2, 4, 6]));
    expect(buffer.complete).toBe(false);
    expect(buffer.sampled).toBe(true);
    expect(viewport3DTargetFieldBufferCanServeVectors(buffer)).toBe(true);
    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "x")).toBe(false);
    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "orientation"))
      .toBe(false);
    expect(
      viewport3DTargetFieldBufferCanServeSurface(
        buffer,
        "orientation",
        undefined,
        "surface_faces",
      ),
    ).toBe(true);
    expect(
      viewport3DTargetFieldBufferCanServeSurface(
        buffer,
        "orientation",
        undefined,
        "thickness_average_z",
      ),
    ).toBe(true);
  });

  it("treats sampled payload metadata as sampled even without max_samples in the query", () => {
    const buffer = buildViewport3DTargetFieldBuffer({
      fieldVector: vectorFixture({
        indexing: "sampled_node_indices",
        meshTopologyHash: "hash-1",
        nodeIndices: new Uint32Array([0, 2, 4, 6]),
      }),
      query: {
        component: "full",
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
    });

    expect(buffer.capability).toBe("full-vector-sampled");
    expect(buffer.complete).toBe(false);
    expect(buffer.sampled).toBe(true);
    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "x")).toBe(false);
    expect(
      viewport3DTargetFieldBufferCanServeSurface(
        buffer,
        "x",
        undefined,
        "surface_faces",
      ),
    ).toBe(true);
    expect(viewport3DTargetFieldBufferCanServeVectors(buffer)).toBe(true);
  });

  it("rejects sampled payloads for glyphs when node indices are absent", () => {
    const buffer = buildViewport3DTargetFieldBuffer({
      fieldVector: vectorFixture({
        indexing: "sampled_node_indices",
        meshTopologyHash: "hash-1",
      }),
      query: {
        component: "full",
        max_samples: 128,
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
    });

    expect(viewport3DTargetFieldBufferCanServeVectors(buffer)).toBe(false);
    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "orientation"))
      .toBe(false);
  });

  it("rejects explicit node-index payloads without topology hash", () => {
    const buffer = buildViewport3DTargetFieldBuffer({
      fieldVector: vectorFixture({
        indexing: "explicit_node_indices",
        nodeIndices: new Uint32Array([0, 2, 4, 6]),
      }),
      query: {
        component: "full",
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
    });

    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "orientation"))
      .toBe(false);
    expect(viewport3DTargetFieldBufferCanServeVectors(buffer)).toBe(false);
  });

  it("accepts explicit node-index payloads with matching map metadata", () => {
    const buffer = buildViewport3DTargetFieldBuffer({
      fieldVector: vectorFixture({
        indexing: "explicit_node_indices",
        meshTopologyHash: "hash-1",
        nodeIndices: new Uint32Array([0, 2, 4, 6]),
      }),
      query: {
        component: "full",
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
      topologyRevision: "topology-1",
    });

    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "orientation"))
      .toBe(true);
    expect(viewport3DTargetFieldBufferCanServeVectors(buffer)).toBe(true);
    expect(buffer.bufferId).toContain("hash-1");
    expect(buffer.bufferId).toContain("explicit_node_indices");
  });

  it("keeps planner pass consumers on target field buffers", () => {
    const buffer = buildViewport3DTargetFieldBuffer({
      consumers: ["part-a:vector-glyph", "part-a:surface"],
      fieldVector: vectorFixture(),
      query: {
        component: "full",
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
    });

    expect(buffer.consumers).toEqual([
      "part-a:surface",
      "part-a:vector-glyph",
    ]);
  });

  it("resolves target buffers before legacy part field vectors", () => {
    const globalFieldVector = vectorFixture({ quantityId: "m" });
    const legacyPartFieldVector = vectorFixture({ quantityId: "H_eff" });
    const targetFieldVector = vectorFixture({ quantityId: "B_demag" });
    const targetBuffer = buildViewport3DTargetFieldBuffer({
      fieldVector: targetFieldVector,
      query: {
        component: "full",
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
    });

    expect(
      resolveViewport3DTargetFieldInput({
        fallbackFieldVector: globalFieldVector,
        legacyPartFieldVectors: new Map([["part-a", legacyPartFieldVector]]),
        partId: "part-a",
        targetFieldBuffers: new Map([["part-a", targetBuffer]]),
      }),
    ).toEqual({
      explicitFieldBuffer: targetBuffer,
      explicitFieldVector: targetFieldVector,
      fieldVector: targetFieldVector,
      source: "target-buffer",
    });
  });

  it("does not fall back to legacy or global field vectors when target buffers are authoritative", () => {
    const globalFieldVector = vectorFixture({ quantityId: "m" });
    const legacyPartFieldVector = vectorFixture({ quantityId: "H_eff" });

    expect(
      resolveViewport3DTargetFieldInput({
        fallbackFieldVector: globalFieldVector,
        legacyPartFieldVectors: new Map([["part-a", legacyPartFieldVector]]),
        partId: "part-a",
        targetFieldBuffers: new Map(),
      }),
    ).toEqual({
      explicitFieldBuffer: null,
      explicitFieldVector: null,
      fieldVector: null,
      source: "none",
    });
  });

  it("marks legacy part field vectors as compatibility fallback only", () => {
    const globalFieldVector = vectorFixture({ quantityId: "m" });
    const legacyPartFieldVector = vectorFixture({ quantityId: "H_eff" });

    expect(
      resolveViewport3DTargetFieldInput({
        fallbackFieldVector: globalFieldVector,
        legacyPartFieldVectors: new Map([["part-a", legacyPartFieldVector]]),
        partId: "part-a",
      }),
    ).toEqual({
      explicitFieldBuffer: null,
      explicitFieldVector: legacyPartFieldVector,
      fieldVector: legacyPartFieldVector,
      source: "legacy-part-field-vector",
    });

    expect(
      resolveViewport3DTargetFieldInput({
        fallbackFieldVector: globalFieldVector,
        partId: "part-b",
      }),
    ).toEqual({
      explicitFieldBuffer: null,
      explicitFieldVector: null,
      fieldVector: globalFieldVector,
      source: "fallback-field-vector",
    });
  });

  it("allows scalar component buffers for component surfaces but not vectors", () => {
    const buffer = buildViewport3DTargetFieldBuffer({
      fieldVector: vectorFixture({
        nComp: 1,
        quantityId: "h_eff",
        valueCount: 4,
        values: new Float64Array(4),
      }),
      query: {
        component: "x",
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
    });

    expect(buffer.capability).toBe("scalar-complete");
    expect(buffer.component).toBe("x");
    expect(buffer.quantityId).toBe("H_eff");
    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "x")).toBe(true);
    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "y")).toBe(false);
    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "magnitude"))
      .toBe(false);
    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "orientation"))
      .toBe(false);
    expect(viewport3DTargetFieldBufferCanServeVectors(buffer)).toBe(false);
  });

  it("rejects otherwise compatible buffers from another requested quantity", () => {
    const scalarBuffer = buildViewport3DTargetFieldBuffer({
      fieldVector: vectorFixture({
        nComp: 1,
        quantityId: "m",
        valueCount: 4,
        values: new Float64Array(4),
      }),
      query: {
        component: "x",
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
    });
    const vectorBuffer = buildViewport3DTargetFieldBuffer({
      fieldVector: vectorFixture({ quantityId: "m" }),
      query: {
        component: "full",
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
    });

    expect(
      viewport3DTargetFieldBufferCanServeSurface(scalarBuffer, "x", "H_eff"),
    ).toBe(false);
    expect(
      viewport3DTargetFieldBufferCanServeSurface(scalarBuffer, "x", "m"),
    ).toBe(true);
    expect(
      viewport3DTargetFieldBufferCanServeVectors(vectorBuffer, "H_eff"),
    ).toBe(false);
    expect(
      viewport3DTargetFieldBufferCanServeVectors(vectorBuffer, "m"),
    ).toBe(true);
  });

  it("does not expose FMVP v3 fields without a current domain generation", () => {
    const buffer = buildViewport3DTargetFieldBuffer({
      fieldVector: vectorFixture({
        domainGenerationId: "43",
        formatVersion: 3,
        indexing: "full_domain",
        meshTopologyHash: "hash-1",
        meshTopologyRevision: "topology-1",
      }),
      query: { component: "full", scope_kind: "full" },
      targetIds: ["part-a"],
    });

    expect(buffer.domainCompatibility).toMatchObject({
      reason: "domain-generation-unknown",
      status: "mismatch",
    });
    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "x")).toBe(false);
    expect(viewport3DTargetFieldBufferCanServeVectors(buffer)).toBe(false);
  });

  it("keeps current domain identity independent from decoded field identity", () => {
    const buffer = buildViewport3DTargetFieldBuffer({
      domain: {
        domainGenerationId: "current-domain",
        meshTopologyHash: "current-topology",
        meshTopologyRevision: "current-topology-revision",
        pointCount: 4,
      },
      fieldVector: vectorFixture({
        domainGenerationId: "decoded-domain",
        formatVersion: 3,
        indexing: "full_domain",
        meshTopologyHash: "decoded-topology",
        meshTopologyRevision: "decoded-topology-revision",
      }),
      query: { component: "full", scope_kind: "full" },
      targetIds: ["part-a"],
    });

    expect(buffer.domainGenerationId).toBe("decoded-domain");
    expect(buffer.meshTopologyHash).toBe("decoded-topology");
    expect(buffer.currentDomainGenerationId).toBe("current-domain");
    expect(buffer.currentMeshTopologyHash).toBe("current-topology");
  });

  it("treats synthetic airbox payloads as vector-capable render fallbacks", () => {
    const buffer = buildViewport3DTargetFieldBuffer({
      fieldVector: vectorFixture({ quantityId: "H_eff" }),
      query: {
        component: "full",
        scope_id: "airbox",
        scope_kind: "airbox",
      },
      synthetic: true,
      targetIds: ["airbox"],
    });

    expect(buffer.capability).toBe("synthetic-full-vector");
    expect(buffer.requestId).toBeNull();
    expect(viewport3DTargetFieldBufferCanServeVectors(buffer)).toBe(true);
    expect(viewport3DTargetFieldBufferCanServeSurface(buffer, "x")).toBe(false);
  });
});
