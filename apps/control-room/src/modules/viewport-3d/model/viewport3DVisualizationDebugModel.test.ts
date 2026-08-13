import { describe, expect, it } from "vitest";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

import {
  buildViewport3DVisualizationDebugSnapshot,
  enforceViewport3DVisualizationDebugSnapshotLimit,
  type Viewport3DVisualizationDebugCarrierInput,
} from "./viewport3DVisualizationDebugModel";

function field(scopeKind: DecodedFieldVector["scopeKind"] = "airbox", scopeId: string | null = "airbox"): DecodedFieldVector {
  return {
    dtype: "float64",
    domainGenerationId: "domain-1",
    formatVersion: 3,
    grid: [2, 1, 1],
    indexing: "explicit_node_indices",
    meshTopologyHash: "topology-hash",
    meshTopologyRevision: "topology-1",
    nComp: 3,
    nodeIndices: new Uint32Array([4, 8]),
    pointCount: 2,
    quantityId: "H_demag",
    scopeId,
    scopeKind,
    valueCount: 6,
    values: new Float64Array([1, 2, 3, 4, 5, 6]),
  };
}

function carrier(overrides: Partial<Viewport3DVisualizationDebugCarrierInput> = {}): Viewport3DVisualizationDebugCarrierInput {
  const decoded = field();
  return {
    cache: {
      byteLength: 240,
      dataIdentityMatches: true,
      entryState: "ready",
      etag: "etag-1",
      key: "resource-1",
      responseMetadata: {
        component: "full",
        domainGenerationId: "domain-1",
        encoding: "FMVP;version=3",
        fieldIndexing: "explicit_node_indices",
        fieldRevision: "field-1",
        identityIssues: [],
        meshTopologyHash: "topology-hash",
        nComp: 3,
        nodeIndexCount: 2,
        pointCount: 2,
        quantityId: "H_demag",
        scopeId: "airbox",
        scopeKind: "airbox",
        snapshotId: null,
        valueCount: 6,
      },
      retainCount: 1,
    },
    carrierId: "part:__air__",
    carrierRole: "air",
    decoded,
    expectedDomainGenerationId: "domain-1",
    expectedTopologyHash: "topology-hash",
    fieldBufferId: "buffer-1",
    fieldBufferRevision: "etag-1",
    fieldBufferState: "target-buffer",
    fieldRevision: "field-1",
    plannerRequestId: "request-1",
    renderedComponent: "full",
    requestIdentityKnown: true,
    requestedComponent: "full",
    requestedPasses: ["surface", "vector-glyph"],
    requestedQuantityId: "H_demag",
    requestedScopeId: "airbox",
    requestedScopeKind: "airbox",
    resourceKey: "resource-1",
    scalarBufferByteLength: 24,
    scalarBufferKey: "scalar-1",
    scanState: "complete",
    scannedStats: {
      finiteCount: 6,
      max: 6,
      mean: 3.5,
      min: 1,
      nonFiniteCount: 0,
      p01: 1,
      p99: 6,
      source: "decoded-payload",
      zeroCount: 0,
    },
    surfaceDegradation: null,
    surfaceProjectionMode: "magnitude",
    surfaceAdoptedFieldBufferId: "buffer-1",
    surfaceAdoptedResourceKey: "resource-1",
    surfaceAdoptedScalarBufferKey: "scalar-1",
    surfaceAdoptedAtMs: 1,
    surfaceAdoptionSequence: 1,
    topologyByteLength: 900,
    vectorBuildKey: "vector-1",
    vectorDegradation: null,
    vectorAdoptedAtMs: 2,
    vectorAdoptedBuildKey: "vector-1",
    vectorAdoptedFieldBufferId: "buffer-1",
    vectorAdoptedItemCount: 2,
    vectorAdoptedResourceKey: "resource-1",
    vectorAdoptionSequence: 2,
    vectorSegmentByteLength: 48,
    vectorSegmentCount: 2,
    ...overrides,
  };
}

function snapshot(carriers: readonly Viewport3DVisualizationDebugCarrierInput[], kind: "airbox" | "object" | "region" = "airbox") {
  return buildViewport3DVisualizationDebugSnapshot({
    capturedAtMs: 100,
    carriers,
    fieldCacheBudget: { byteLength: 240, entryCount: 1, maxBytes: 1024 },
    frame: { committedAtMs: 90, commitId: "frame-1", contextLost: false, drawingBuffer: [800, 600], viewportId: "viewport-1" },
    target: { id: kind === "airbox" ? "airbox" : `${kind}:1`, kind, label: kind },
    visualizationRevision: "vis-1",
    webglSharedByteLength: null,
  });
}

describe("buildViewport3DVisualizationDebugSnapshot", () => {
  it("builds a complete scoped Airbox snapshot with exact memory rows", () => {
    const result = snapshot([carrier()]);
    expect(result.target).toEqual({ carrierIds: ["part:__air__"], id: "airbox", kind: "airbox", label: "airbox" });
    expect(result.disposition).toBe("ready");
    expect(result.carriers[0]?.memory.map((row) => [row.id, row.byteLength, row.ownership])).toEqual([
      ["wire", null, "estimated"], ["cache", 240, "estimated"], ["values", 48, "owned"], ["node-indices", 8, "owned"],
      ["scalar-buffer", 24, "owned"], ["vector-segments", 48, "owned"], ["topology", 900, "referenced"],
    ]);
    expect(Object.isFrozen(result.carriers)).toBe(true);
    expect(Object.isFrozen(result.carriers[0]!.memory)).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(64 * 1024);
  });

  it("exports the exact response topology hash when FMVP stores raw hash bytes", () => {
    const base = carrier();
    const result = snapshot([
      carrier({
        cache: {
          ...base.cache!,
          responseMetadata: {
            ...base.cache!.responseMetadata!,
            meshTopologyHash: "sha256:topology-hash",
          },
        },
      }),
    ]);

    expect(result.carriers[0]?.revisions.meshTopologyHash).toBe(
      "sha256:topology-hash",
    );
  });

  it.each([
    ["actual field revision", { fieldRevision: null }],
    ["current domain generation", { expectedDomainGenerationId: null }],
    ["current topology hash", { expectedTopologyHash: null }],
    [
      "response metadata",
      {
        cache: {
          byteLength: 240,
          dataIdentityMatches: true,
          entryState: "ready" as const,
          etag: "etag-1",
          key: "resource-1",
          responseMetadata: null,
          retainCount: 1,
        },
      },
    ],
  ] as const)("keeps missing required %s proof unknown", (_label, overrides) => {
    const result = snapshot([carrier(overrides)]);
    expect(result.disposition).toBe("unknown");
  });

  it.each([
    [
      "different cache entry",
      { cache: { ...carrier().cache!, dataIdentityMatches: false } },
    ],
    ["different cached ETag", { fieldBufferRevision: "etag-2" }],
  ] as const)(
    "does not report ready for a field buffer backed by a %s",
    (_label, overrides) => {
      const result = snapshot([carrier(overrides)]);

      expect(result.disposition).toBe("degraded");
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: "field-revision-stale" }),
      );
    },
  );

  it("keeps an all-null FMVP v3 response-metadata shell unknown", () => {
    const result = snapshot([
      carrier({
        cache: {
          byteLength: 240,
          dataIdentityMatches: true,
          entryState: "ready",
          etag: "etag-1",
          key: "resource-1",
          responseMetadata: {
            component: null,
            domainGenerationId: null,
            encoding: null,
            fieldIndexing: null,
            fieldRevision: null,
            identityIssues: [],
            meshTopologyHash: null,
            nComp: null,
            nodeIndexCount: null,
            pointCount: null,
            quantityId: null,
            scopeId: null,
            scopeKind: null,
            snapshotId: null,
            valueCount: null,
          },
          retainCount: 1,
        },
      }),
    ]);

    expect(result.disposition).toBe("unknown");
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ code: "response-metadata-mismatch" }),
    );
  });

  it("accepts legal full-domain metadata without scoped or node-index headers", () => {
    const decoded = field("full", null);
    decoded.indexing = "full_domain";
    decoded.nodeIndices = null;
    const result = snapshot([
      carrier({
        cache: {
          ...carrier().cache!,
          responseMetadata: {
            ...carrier().cache!.responseMetadata!,
            fieldIndexing: "full_domain",
            nodeIndexCount: null,
            scopeId: null,
            scopeKind: null,
          },
        },
        decoded,
        requestedScopeId: null,
        requestedScopeKind: "full",
      }),
    ]);

    expect(result.disposition).toBe("ready");
  });

  it("accepts semantic component aliases but blocks a known component mismatch", () => {
    const matching = snapshot([
      carrier({
        cache: {
          ...carrier().cache!,
          responseMetadata: {
            ...carrier().cache!.responseMetadata!,
            component: "c0",
          },
        },
        renderedComponent: "x",
        requestedComponent: "x",
      }),
    ]);
    const mismatching = snapshot([
      carrier({
        cache: {
          ...carrier().cache!,
          responseMetadata: {
            ...carrier().cache!.responseMetadata!,
            component: "c1",
          },
        },
        renderedComponent: "x",
        requestedComponent: "x",
      }),
    ]);

    expect(matching.disposition).toBe("ready");
    expect(mismatching.disposition).toBe("blocked");
    expect(mismatching.issues).toContainEqual(
      expect.objectContaining({ code: "response-metadata-mismatch" }),
    );
  });

  it("blocks a known response encoding mismatch", () => {
    const result = snapshot([
      carrier({
        cache: {
          ...carrier().cache!,
          responseMetadata: {
            ...carrier().cache!.responseMetadata!,
            encoding: "FMVP;version=2",
          },
        },
      }),
    ]);

    expect(result.disposition).toBe("blocked");
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "response-metadata-mismatch" }),
    );
  });

  it.each([
    ["valueCount", "value-count-mismatch"],
    ["nodeIndexCount", "node-index-count-mismatch"],
  ] as const)(
    "maps a production response-metadata %s identity issue to its specific health code",
    (fieldName, issueCode) => {
      const result = snapshot([
        carrier({
          cache: {
            ...carrier().cache!,
            responseMetadata: {
              ...carrier().cache!.responseMetadata!,
              identityIssues: [
                { field: fieldName, headerValue: 999, payloadValue: 6 },
              ],
            },
          },
        }),
      ]);

      expect(result.disposition).toBe("blocked");
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: issueCode }),
      );
    },
  );

  it("keeps optional range and outlier comparisons non-blocking", () => {
    const result = snapshot([
      carrier({
        rangeDiagnostics: null,
      }),
    ]);

    expect(result.disposition).toBe("ready");
  });

  it.each(["object", "region"] as const)("builds a scoped %s target", (kind) => {
    const id = `${kind}:1`;
    const payloadScope = kind === "region" ? "selection" : "object";
    const result = snapshot([carrier({ carrierId: "part:magnet", carrierRole: "magnetic", decoded: field(payloadScope, id), requestedScopeId: id, requestedScopeKind: payloadScope })], kind);
    expect(result.target.kind).toBe(kind);
    expect(result.carriers[0]?.payload?.scopeKind).toBe(payloadScope);
  });

  it("keeps two object carriers separate and does not double-count shared memory", () => {
    const sharedBuffer = new ArrayBuffer(64);
    const sharedValues = new Float64Array(sharedBuffer, 0, 6);
    const sharedIndices = new Uint32Array(sharedBuffer, 48, 2);
    const sharedField = { ...field("object", "object:1"), nodeIndices: sharedIndices, values: sharedValues };
    const one = carrier({ carrierId: "part:a", decoded: sharedField, requestedScopeId: "object:1", requestedScopeKind: "object", webglSharedByteLength: 700 });
    const two = carrier({ carrierId: "part:b", decoded: sharedField, requestedScopeId: "object:1", requestedScopeKind: "object", webglSharedByteLength: 700 });
    const result = buildViewport3DVisualizationDebugSnapshot({
      capturedAtMs: 100,
      carriers: [one, two],
      fieldCacheBudget: { byteLength: 240, entryCount: 1, maxBytes: 1024 },
      frame: { committedAtMs: 90, commitId: "frame-1", contextLost: false, drawingBuffer: [800, 600], viewportId: "viewport-1" },
      target: { id: "object:1", kind: "object", label: "object" },
      visualizationRevision: "vis-1",
      webglSharedByteLength: 700,
    });
    expect(result.carriers.map((item) => item.carrierId)).toEqual(["part:a", "part:b"]);
    expect(result.sharedMemory).toContainEqual(expect.objectContaining({ id: "field-cache-budget", byteLength: 240, ownership: "estimated" }));
    expect(result.sharedMemory.filter((row) => row.id === "field-cache-budget")).toHaveLength(1);
    expect(result.sharedMemory.filter((row) => row.id === "webgl")).toEqual([
      expect.objectContaining({ byteLength: 700, ownership: "shared" }),
    ]);
    expect(result.carriers[0]?.memory.find((row) => row.id === "wire")?.ownership).toBe("estimated");
    expect(result.carriers[0]?.memory.find((row) => row.id === "cache")?.ownership).toBe("estimated");
    expect(result.carriers[1]?.memory.find((row) => row.id === "values")?.ownership).toBe("referenced");
    expect(result.memoryTotals).toEqual({ owned: 136, referenced: 900, shared: 700 });
  });

  it("represents derived-global FDM data as a full-domain carrier with geometry mask", () => {
    const result = snapshot([carrier({ carrierId: "fdm-domain", carrierRole: "fdm-domain", decoded: field("full", null), fieldBufferState: "derived-global", geometryMaskDescription: "object object:1", requestedScopeId: null, requestedScopeKind: "full" })], "object");
    expect(result.carriers[0]?.payload).toMatchObject({ scopeId: null, scopeKind: "full" });
    expect(result.carriers[0]?.geometryMaskDescription).toBe("object object:1");
  });

  it("keeps missing legacy payload identity null and reports insufficient evidence as unknown", () => {
    const legacyField: DecodedFieldVector = {
      domainGenerationId: null,
      dtype: "float64",
      formatVersion: 2,
      grid: [1, 1, 1],
      indexing: "legacy_count_only",
      meshTopologyHash: null,
      meshTopologyRevision: null,
      nComp: 3,
      nodeIndices: null,
      pointCount: 1,
      quantityId: "m",
      scopeId: null,
      scopeKind: null,
      valueCount: 3,
      values: new Float64Array([1, 0, 0]),
    };
    const result = snapshot([
      carrier({
        cache: {
          ...carrier().cache!,
          responseMetadata: null,
        },
        decoded: legacyField,
        expectedDomainGenerationId: null,
        expectedTopologyHash: null,
        requestedQuantityId: "m",
        requestedScopeId: null,
        requestedScopeKind: "full",
      }),
    ]);

    expect(result.carriers[0]?.payload).toMatchObject({
      formatVersion: 2,
      scopeId: null,
      scopeKind: null,
    });
    expect(result.carriers[0]?.revisions).toMatchObject({
      domainGenerationId: null,
      meshTopologyHash: null,
      topologyRevision: null,
    });
    expect(result.disposition).toBe("unknown");
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ code: "scope-kind-mismatch" }),
    );
  });

  it("reports a trusted response generation for a legacy FMVP v2 payload", () => {
    const legacyField: DecodedFieldVector = {
      domainGenerationId: null,
      dtype: "float64",
      formatVersion: 2,
      grid: [1, 1, 1],
      indexing: "legacy_count_only",
      meshTopologyHash: null,
      meshTopologyRevision: null,
      nComp: 3,
      nodeIndices: null,
      pointCount: 1,
      quantityId: "H_demag",
      scopeId: null,
      scopeKind: null,
      valueCount: 3,
      values: new Float64Array([1, 0, 0]),
    };
    const result = snapshot([
      carrier({
        cache: {
          ...carrier().cache!,
          responseMetadata: {
            ...carrier().cache!.responseMetadata!,
            domainGenerationId: "fdm-generation-7",
            encoding: "FMVP;version=2",
            identityIssues: [
              {
                field: "domainGenerationId",
                headerValue: "fdm-generation-7",
                payloadValue: null,
              },
            ],
          },
        },
        decoded: legacyField,
        expectedDomainGenerationId: "fdm-generation-7",
        expectedTopologyHash: null,
        requestedQuantityId: "H_demag",
        requestedScopeId: null,
        requestedScopeKind: "full",
      }),
    ]);

    expect(result.carriers[0]?.payload).toMatchObject({
      formatVersion: 2,
      scopeId: null,
      scopeKind: null,
    });
    expect(result.carriers[0]?.revisions.domainGenerationId).toBe(
      "fdm-generation-7",
    );
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ code: "response-metadata-mismatch" }),
    );
  });

  it("evaluates a known decoded scope id independently of an unknown scope kind", () => {
    const mismatching = snapshot([
      carrier({
        decoded: field(null, "other"),
        requestedScopeId: "airbox",
        requestedScopeKind: "airbox",
      }),
    ]);
    const unknown = snapshot([
      carrier({
        decoded: field(null, null),
        requestedScopeId: "airbox",
        requestedScopeKind: "airbox",
      }),
    ]);

    expect(mismatching.disposition).toBe("blocked");
    expect(mismatching.issues).toContainEqual(
      expect.objectContaining({ code: "scope-id-mismatch" }),
    );
    expect(unknown.disposition).toBe("unknown");
    expect(unknown.issues).not.toContainEqual(
      expect.objectContaining({ code: "scope-id-mismatch" }),
    );
  });

  it("requires separate matching adoption evidence for every requested render pass", () => {
    const missing = snapshot([
      carrier({
        surfaceAdoptedScalarBufferKey: null,
        vectorAdoptedBuildKey: null,
        surfaceAdoptedFieldBufferId: null,
        surfaceAdoptedResourceKey: null,
        vectorAdoptedFieldBufferId: null,
        vectorAdoptedResourceKey: null,
      }),
    ]);
    const surfaceOnly = snapshot([
      carrier({
        vectorAdoptedBuildKey: null,
        vectorAdoptedFieldBufferId: null,
        vectorAdoptedResourceKey: null,
      }),
    ]);
    const vectorOnly = snapshot([
      carrier({
        surfaceAdoptedScalarBufferKey: null,
        surfaceAdoptedFieldBufferId: null,
        surfaceAdoptedResourceKey: null,
      }),
    ]);
    const matching = snapshot([carrier()]);
    const mismatching = snapshot([
      carrier({ vectorAdoptedBuildKey: "other-vector" }),
    ]);
    const partialKnownMismatch = snapshot([
      carrier({
        surfaceAdoptedScalarBufferKey: null,
        surfaceAdoptedFieldBufferId: null,
        surfaceAdoptedResourceKey: null,
        vectorAdoptedFieldBufferId: "other-buffer",
      }),
    ]);

    for (const incomplete of [missing, surfaceOnly, vectorOnly]) {
      expect(incomplete.disposition).toBe("unknown");
      expect(incomplete.issues).not.toContainEqual(
        expect.objectContaining({ code: "adopted-source-mismatch" }),
      );
    }
    expect(matching.disposition).toBe("ready");
    expect(mismatching.disposition).toBe("degraded");
    expect(mismatching.issues).toContainEqual(
      expect.objectContaining({ code: "adopted-source-mismatch" }),
    );
    expect(partialKnownMismatch.disposition).toBe("degraded");
    expect(partialKnownMismatch.issues).toContainEqual(
      expect.objectContaining({ code: "adopted-source-mismatch" }),
    );
  });

  it.each([
    [
      "surface field",
      {
        surfaceAdoptedScalarBufferKey: null,
        requestedPasses: ["surface"],
        surfaceAdoptedFieldBufferId: "other-buffer",
      },
    ],
    [
      "surface scalar key",
      {
        surfaceAdoptedScalarBufferKey: "other-scalar",
        requestedPasses: ["surface"],
        surfaceAdoptedFieldBufferId: null,
      },
    ],
    [
      "surface resource",
      {
        surfaceAdoptedScalarBufferKey: null,
        requestedPasses: ["surface"],
        surfaceAdoptedFieldBufferId: null,
        surfaceAdoptedResourceKey: "other-resource",
      },
    ],
    [
      "vector field",
      {
        vectorAdoptedBuildKey: null,
        requestedPasses: ["vector-glyph"],
        vectorAdoptedFieldBufferId: "other-buffer",
      },
    ],
    [
      "vector build key",
      {
        vectorAdoptedBuildKey: "other-vector",
        requestedPasses: ["vector-glyph"],
        vectorAdoptedFieldBufferId: null,
      },
    ],
    [
      "vector resource",
      {
        vectorAdoptedBuildKey: null,
        requestedPasses: ["vector-glyph"],
        vectorAdoptedFieldBufferId: null,
        vectorAdoptedResourceKey: "other-resource",
      },
    ],
  ] as const)(
    "does not hide a known %s mismatch behind missing same-pass proof",
    (_label, overrides) => {
      const result = snapshot([carrier(overrides)]);
      expect(result.disposition).toBe("degraded");
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: "adopted-source-mismatch" }),
      );
    },
  );

  it("treats a synthetic render field buffer as present without calling it decoded FMVP", () => {
    const result = snapshot([
      carrier({
        decoded: null,
        fieldBufferId: "synthetic:airbox:vectors",
        fieldBufferState: "synthetic",
        requestedPasses: ["vector-glyph"],
        scalarBufferByteLength: null,
        scalarBufferKey: null,
        vectorAdoptedFieldBufferId: "synthetic:airbox:vectors",
      }),
    ]);

    expect(result.carriers[0]?.payload).toBeNull();
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ code: "field-buffer-missing" }),
    );
    expect(result.disposition).toBe("unknown");
  });

  it("keeps decoded component absent while reporting the actual rendered component", () => {
    const result = snapshot([
      carrier({ renderedComponent: "x", requestedComponent: "full" }),
    ]);

    expect(result.carriers[0]?.payload?.component).toBeNull();
    expect(result.carriers[0]?.render.surface.colorMode).toBe("x");
  });

  it("does not count shared bytes as owned and preserves unknown attribution as null", () => {
    const result = snapshot([carrier({ cache: null, topologyByteLength: null, webglSharedByteLength: null })]);
    expect(result.carriers[0]?.memory).toContainEqual(expect.objectContaining({ id: "wire", byteLength: null }));
    expect(result.ownedByteLength).toBe(128);
    expect(result.sharedMemory).toContainEqual(expect.objectContaining({ id: "webgl", byteLength: null, ownership: "shared" }));
    expect(result.memoryTotals).toEqual({ owned: 128, referenced: null, shared: null });
  });

  it("keeps referenced attribution unknown without a stable topology identity", () => {
    const result = snapshot([carrier({ expectedTopologyHash: null, topologyByteLength: 900 })]);
    expect(result.carriers[0]?.memory).toContainEqual(
      expect.objectContaining({ id: "topology", byteLength: 900, ownership: "referenced" }),
    );
    expect(result.memoryTotals?.referenced).toBeNull();
  });

  it("preserves known empty shared and referenced attribution as zero", () => {
    const result = buildViewport3DVisualizationDebugSnapshot({
      capturedAtMs: 100,
      carriers: [carrier({ topologyByteLength: 0 })],
      fieldCacheBudget: { byteLength: 0, entryCount: 0, maxBytes: 1024 },
      frame: { committedAtMs: 90, commitId: "frame-1", contextLost: false, drawingBuffer: [800, 600], viewportId: "viewport-1" },
      target: { id: "airbox", kind: "airbox", label: "airbox" },
      visualizationRevision: "vis-1",
      webglSharedByteLength: 0,
    });
    expect(result.memoryTotals).toEqual({ owned: 128, referenced: 0, shared: 0 });
  });

  it("uses render range diagnostics only for the exact rendered component", () => {
    const rangeDiagnostics = {
      finiteCount: 2,
      max: 6,
      mean: 3.5,
      min: 1,
      nonFiniteCount: 0,
      outlierDominated: false,
      p01: 1,
      p99: 6,
      zeroCount: 0,
    };
    const matching = snapshot([carrier({ rangeDiagnostics, rangeDiagnosticsComponent: "full", scannedStats: null })]);
    const mismatching = snapshot([carrier({ rangeDiagnostics, rangeDiagnosticsComponent: "x", scannedStats: null })]);
    expect(matching.carriers[0]?.statistics).toContainEqual(expect.objectContaining({ source: "render-derived" }));
    expect(mismatching.carriers[0]?.statistics).toEqual([]);
    expect(mismatching.carriers[0]?.scanState).toBe("complete");
  });

  it("bounds carrier collections and diagnostic text below the controller limit", () => {
    const longText = "x".repeat(20_000);
    const carriers = Array.from({ length: 20 }, (_, index) =>
      carrier({ carrierId: `${index}:${longText}`, geometryMaskDescription: longText, plannerRequestId: longText, resourceKey: longText }),
    );
    const result = snapshot(carriers);
    expect(result.carriers).toHaveLength(8);
    expect(result.carriers[0]?.carrierId.length).toBeLessThanOrEqual(256);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(64 * 1024);
  });

  it("caps issues at 20 and bounds requested pass collections", () => {
    const broken = carrier({
      surfaceAdoptedFieldBufferId: "wrong",
      vectorAdoptedFieldBufferId: "wrong",
      decoded: field("part", "other"),
      fieldBufferId: null,
      requestedPasses: Array.from({ length: 100 }, (_, index) => index % 2 ? "surface" : "vector-glyph"),
    });
    const result = snapshot(Array.from({ length: 8 }, (_, index) => ({ ...broken, carrierId: `part:${index}` })));
    expect(result.issues.length).toBeLessThanOrEqual(20);
    expect(result.carriers[0]?.render.requestedPasses.length).toBeLessThanOrEqual(8);
  });

  it("retains a late carrier error when severity-prioritizing the snapshot cap", () => {
    const soft = carrier({
      rangeDiagnostics: {
        finiteCount: 2,
        max: 0,
        mean: 0,
        min: 0,
        nonFiniteCount: 0,
        outlierDominated: true,
        p01: 0,
        p99: 0,
        zeroCount: 2,
      },
      rangeDiagnosticsComponent: "full",
      scalarBufferByteLength: null,
      scannedStats: null,
      vectorSegmentByteLength: null,
    });
    const result = snapshot([
      ...Array.from({ length: 6 }, (_, index) => ({
        ...soft,
        carrierId: `soft:${index}`,
      })),
      carrier({ carrierId: "late:error", requestedQuantityId: "m" }),
    ]);

    expect(result.disposition).toBe("blocked");
    expect(result.issues.length).toBeLessThanOrEqual(20);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "quantity-mismatch", severity: "error" }),
    );
  });

  it("does not report a missing field when no field-dependent pass is requested", () => {
    const result = snapshot([carrier({
      surfaceAdoptedScalarBufferKey: null,
      vectorAdoptedBuildKey: null,
      decoded: null,
      fieldBufferState: "missing",
      requestedPasses: [],
      surfaceAdoptedFieldBufferId: null,
      surfaceAdoptedResourceKey: null,
      vectorAdoptedFieldBufferId: null,
      vectorAdoptedResourceKey: null,
    })]);
    expect(result.issues).not.toContainEqual(expect.objectContaining({ code: "field-buffer-missing" }));
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ code: "adopted-source-mismatch" }),
    );
    expect(result.disposition).toBe("unknown");
  });

  it("normalizes unsafe numeric input and emits a deterministic bounded UTF-8 fallback", () => {
    const unsafe = snapshot([carrier({ scalarBufferByteLength: Number.POSITIVE_INFINITY, vectorSegmentCount: Number.NaN })]);
    expect(JSON.stringify(unsafe)).not.toMatch(/NaN|Infinity/);
    expect(unsafe.carriers[0]?.render.surface.scalarByteLength).toBe(0);
    expect(unsafe.carriers[0]?.render.vectors.segmentCount).toBe(0);

    const base = snapshot([carrier()]);
    const oversized = enforceViewport3DVisualizationDebugSnapshotLimit({
      ...base,
      target: { ...base.target, label: "💾".repeat(50_000) },
    });
    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(oversized.issues).toEqual([
      expect.objectContaining({ code: "snapshot-size-limit" }),
    ]);
  });

  it("normalizes malformed runtime collections to bounded empty collections", () => {
    const malformed = carrier({ requestedPasses: null as unknown as readonly ("surface" | "vector-glyph")[] });
    expect(() => snapshot([malformed])).not.toThrow();
    expect(snapshot([malformed]).carriers[0]?.render.requestedPasses).toEqual([]);
  });
});
