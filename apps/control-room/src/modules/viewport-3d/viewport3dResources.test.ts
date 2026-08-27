import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  DATA_FIELDS_PATH,
  DATA_FIELD_META_PATH,
  DATA_FIELD_VECTOR_PATH,
} from "@/kernel/api/apiPaths";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import type { FieldCatalogResource, FieldVectorResponseMetadata } from "@/kernel/api/apiTypes";
import type { DecodedFieldVector } from "@/kernel/api/codecs";
import { ResourceCache } from "@/kernel/resources/ResourceCache";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";

import {
  cachedBinaryResourceMatchesRevision,
  createViewport3DFieldVectorPartialLoadError,
  getViewport3DFieldVectorCacheBudgetDiagnostics,
  getViewport3DFieldVectorCacheEntryDiagnostics,
  inspectViewport3DFieldVectorCacheEntryDiagnostics,
  invalidateViewport3DFieldMetaResources,
  loadCachedBinaryResource,
  loadViewport3DFieldRequestsBounded,
  resolveCachedFieldVectorEnvelope,
  resolveViewport3DAirboxFieldVectorQuery,
  resolveViewport3DAirboxFieldVectorPartStates,
  resolveViewport3DAirboxFieldVectorResourceKeys,
  resolveViewport3DAirboxFieldVectorResourceRequests,
  resolveViewport3DFieldVectorResourceKey,
  resolveViewport3DFieldVectorCollectionLastGood,
  resolveViewport3DFieldVectorRequestStates,
  resolveViewport3DFieldVectorCollectionResourceKey,
  resolveViewport3DPartFieldVectorResourceRequests,
  resolveViewport3DQuantityFieldVectorResourceRequests,
  resolveViewport3DQuantityFieldVectorResourceKeys,
  synchronizeViewport3DSessionIdentity,
  viewport3DFieldVectorMatchesRequestIdentity,
  viewport3DFieldMetaResourceMatchesQuantity,
  type Viewport3DFieldVectorEnvelope,
} from "./viewport3dResources";

const viewport3dResourcesSourceUrl = new URL(
  "./viewport3dResources.ts",
  import.meta.url,
);

const airboxFieldCatalog = {
  domain_generation_id: "fdm-generation-1",
  quantities: [
    { available: true, domain: "full_domain", quantity_id: "H_demag" },
    { available: true, domain: "full_domain", quantity_id: "H_eff" },
    { available: true, domain: "magnetic_only", quantity_id: "m" },
    { available: true, domain: "magnetic_only", quantity_id: "H_ex" },
  ],
  revision: 3,
} as FieldCatalogResource;

function fieldResponseMetadata(
  overrides: Partial<FieldVectorResponseMetadata> = {},
): FieldVectorResponseMetadata {
  return {
    component: "full",
    domainGenerationId: "generation-1",
    encoding: "FMVP;version=2",
    fieldIndexing: null,
    fieldRevision: "1",
    identityIssues: [],
    meshTopologyHash: null,
    nComp: 3,
    nodeIndexCount: null,
    pointCount: 1,
    quantityId: "m",
    scopeId: null,
    scopeKind: null,
    snapshotId: null,
    valueCount: 3,
    ...overrides,
  };
}

describe("viewport3dResources", () => {
  it("purges session caches and stale inflight work synchronously before resource reads", () => {
    const source = readFileSync(viewport3dResourcesSourceUrl, "utf8");
    const hookStart = source.indexOf("function useViewport3DSessionIdentity()");
    const hookEnd = source.indexOf("\n}\n", hookStart);
    const hookSource = source.slice(hookStart, hookEnd);

    expect(hookStart).toBeGreaterThanOrEqual(0);
    expect(hookSource).toContain(
      "synchronizeViewport3DSessionIdentity(identity);",
    );
    expect(hookSource).not.toContain("useEffect(");
    expect(source).toContain("abortViewport3DInflightBinaryResources");
  });

  it("aborts a delayed old-session response before decode or cache adoption", async () => {
    const cache = new ResourceCache<string>({ maxBytes: 32 });
    const decoded = vi.fn();
    const adopted = vi.fn();
    synchronizeViewport3DSessionIdentity({
      sessionEpoch: "session-old@1000",
      sessionId: "session-old",
    });

    const pending = loadCachedBinaryResource(
      cache,
      "session=session-old&epoch=session-old%401000|field:m",
      (_etag, signal) =>
        new Promise((resolve, reject) => {
          const decodeTimer = setTimeout(() => {
            decoded();
            resolve({
              byteLength: 5,
              data: "old",
              etag: '"old"',
              status: "ready",
            });
          }, 1_000);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(decodeTimer);
              reject(new DOMException("old session aborted", "AbortError"));
            },
            { once: true },
          );
        }),
      { onFreshAdoption: adopted },
    );

    synchronizeViewport3DSessionIdentity({
      sessionEpoch: "session-new@2000",
      sessionId: "session-new",
    });

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(decoded).not.toHaveBeenCalled();
    expect(adopted).not.toHaveBeenCalled();
    expect(cache.stats()).toEqual({ byteLength: 0, entryCount: 0 });
  });

  it("rejects a late old-session completion even when the transport ignores abort", async () => {
    const cache = new ResourceCache<string>({ maxBytes: 32 });
    let resolveResponse!: (result: {
      byteLength: number;
      data: string;
      etag: string;
      status: "ready";
    }) => void;
    const adopted = vi.fn();
    synchronizeViewport3DSessionIdentity({
      sessionEpoch: "session-old@1000",
      sessionId: "session-old",
    });
    const pending = loadCachedBinaryResource(
      cache,
      "session=session-old&epoch=session-old%401000|field:m:late",
      () =>
        new Promise((resolve) => {
          resolveResponse = resolve;
        }),
      { onFreshAdoption: adopted },
    );

    synchronizeViewport3DSessionIdentity({
      sessionEpoch: "session-new@2000",
      sessionId: "session-new",
    });
    resolveResponse({
      byteLength: 5,
      data: "late-old",
      etag: '"late-old"',
      status: "ready",
    });

    await expect(pending).rejects.toMatchObject({
      code: "session-identity-changed",
      name: "AbortError",
    });
    expect(adopted).not.toHaveBeenCalled();
    expect(cache.stats()).toEqual({ byteLength: 0, entryCount: 0 });
  });

  it("loads field carriers with bounded priority-aware concurrency", async () => {
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    let active = 0;
    let maxActive = 0;
    const requests = [
      { id: "remaining", consumers: ["target:remaining"] },
      { id: "surface", consumers: ["target:surface-visible"] },
      { id: "selected", consumers: ["object:selected:surface"] },
      { id: "vectors", consumers: ["target:vector-glyph-visible"] },
      { id: "remaining-2", consumers: ["target:remaining"] },
    ];

    const pending = loadViewport3DFieldRequestsBounded(
      requests,
      async (request) => {
        started.push(request.id);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.set(request.id, resolve));
        active -= 1;
        return request.id;
      },
      { concurrency: 2, selectedTargetId: "object:selected" },
    );

    await vi.waitFor(() => expect(started).toEqual(["selected", "vectors"]));
    releases.get("selected")?.();
    await vi.waitFor(() => expect(started).toEqual(["selected", "vectors", "surface"]));
    for (const release of releases.values()) release();
    await vi.waitFor(() => expect(started).toHaveLength(5));
    for (const release of releases.values()) release();

    await expect(pending).resolves.toEqual([
      "selected",
      "vectors",
      "surface",
      "remaining",
      "remaining-2",
    ]);
    expect(maxActive).toBe(2);
  });

  it.each([1, 10, 50])(
    "loads %i carrier requests exactly once within the shared concurrency budget",
    async (requestCount) => {
      let active = 0;
      let maxActive = 0;
      const calls = new Map<number, number>();
      const results = await loadViewport3DFieldRequestsBounded(
        Array.from({ length: requestCount }, (_, id) => ({ consumers: [], id })),
        async ({ id }) => {
          calls.set(id, (calls.get(id) ?? 0) + 1);
          active += 1;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve();
          active -= 1;
          return id;
        },
        { concurrency: 4 },
      );

      expect(results).toHaveLength(requestCount);
      expect([...calls.values()]).toEqual(Array(requestCount).fill(1));
      expect(maxActive).toBe(Math.min(4, requestCount));
    },
  );

  it("keeps the failing quantity request explicit in a partial collection error", () => {
    const error = createViewport3DFieldVectorPartialLoadError({
      cause: new Error("backend rejected H_demag"),
      message: "One or more quantity field vectors are not ready",
      partialData: new Map(),
      requestFailures: [{
        cause: new Error("backend rejected H_demag"),
        key: "vector:H_demag:airbox",
        quantityId: "H_demag",
        query: { component: "full", scope_kind: "airbox" },
        requestId: "quantity=H_demag&component=full&scope_kind=airbox",
      }],
    });

    expect(error).toMatchObject({
      name: "ResourcePartialLoadError",
      requestFailures: expect.arrayContaining([
        expect.objectContaining({
          quantityId: "H_demag",
          query: expect.objectContaining({ scope_kind: "airbox" }),
        }),
      ]),
    });
  });

  it("keeps FEM Airbox failures per carrier and exposes compatible last-good data", () => {
    const makeEnvelope = (
      partId: string,
    ): Viewport3DFieldVectorEnvelope => ({
      data: {
        dtype: "float64",
        formatVersion: 3,
        domainGenerationId: "generation-1",
        grid: [1, 1, 1],
        indexing: "explicit_node_indices",
        meshTopologyHash: "mesh-1",
        nComp: 3,
        nodeIndices: [0],
        pointCount: 1,
        quantityId: "H_demag",
        scopeId: partId,
        scopeKind: "part",
        valueCount: 3,
        values: new Float64Array([1, 0, 0]),
      },
      etag: `field-${partId}-1`,
      responseMetadata: fieldResponseMetadata({
        domainGenerationId: "generation-1",
        meshTopologyHash: "mesh-1",
        quantityId: "H_demag",
        scopeId: partId,
        scopeKind: "part",
      }),
      resourceKey: `field:H_demag:${partId}`,
    });
    const partA = makeEnvelope("part-a");
    const partB = makeEnvelope("part-b");
    const states = resolveViewport3DAirboxFieldVectorPartStates({
      current: new Map([["part-a", partA]]),
      displayed: new Map([
        ["part-a", partA],
        ["part-b", partB],
      ]),
      failures: new Map([
        ["part-b", { reasonCode: "target_carrier_missing", status: 404 }],
        ["part-c", { reasonCode: "field_materialization_pending", status: 202 }],
      ]),
      previous: new Map([
        ["part-a", partA],
        ["part-b", partB],
      ]),
      requests: new Map([
        ["part-a", {}],
        ["part-b", {}],
        ["part-c", {}],
      ]),
      status: "error",
    });

    expect(states.get("part-a")).toMatchObject({
      data: partA.data,
      lastValidData: partA.data,
      reasonCode: null,
      revision: partA.etag,
      status: "ready",
    });
    expect(states.get("part-b")).toMatchObject({
      data: null,
      lastValidData: partB.data,
      reasonCode: "target_carrier_missing",
      revision: partB.etag,
      status: "stale",
    });
    expect(states.get("part-c")).toMatchObject({
      data: null,
      lastValidData: null,
      reasonCode: "field_materialization_pending",
      revision: null,
      status: "pending",
    });
  });

  it("keeps one failed carrier isolated while other request states remain ready", () => {
    const ready = {
      data: {
        dtype: "float64" as const,
        grid: [1, 1, 1] as [number, number, number],
        nComp: 3,
        pointCount: 1,
        quantityId: "m",
        valueCount: 3,
        values: new Float64Array([1, 0, 0]),
      },
      etag: '"m-ready"',
      responseMetadata: fieldResponseMetadata(),
      resourceKey: "field:m:ready",
    };
    const states = resolveViewport3DFieldVectorRequestStates({
      current: new Map([["ready", ready]]),
      displayed: new Map([["ready", ready]]),
      failures: new Map([
        ["failed", { reasonCode: "target_carrier_missing", status: 404 }],
      ]),
      previous: new Map(),
      requests: new Map([["ready", {}], ["failed", {}]]),
      status: "error",
    });

    expect(states.get("ready")?.status).toBe("ready");
    expect(states.get("failed")).toMatchObject({
      data: null,
      reasonCode: "target_carrier_missing",
      status: "unavailable",
    });
  });

  it("retains only last-good field vectors matching the current request identity", () => {
    const previous = new Map<string, Viewport3DFieldVectorEnvelope>([
      [
        "target-a",
        {
          data: {
            dtype: "float64",
            formatVersion: 3,
            domainGenerationId: "generation-1",
            grid: [1, 1, 1] as [number, number, number],
            indexing: "full_domain" as const,
            nComp: 3,
            pointCount: 1,
            quantityId: "m",
            scopeId: "target-a",
            scopeKind: "part" as const,
            valueCount: 3,
            values: new Float64Array([1, 2, 3]),
          },
          etag: '"field-m-1"',
          responseMetadata: fieldResponseMetadata({
            domainGenerationId: "generation-1",
            quantityId: "m",
            scopeId: "target-a",
            scopeKind: "part",
          }),
          resourceKey: "field:m:target-a",
        },
      ],
    ]);
    const requests = new Map([
      [
        "target-a",
        {
          consumers: ["target-a:vector-glyph"],
          quantityId: "m",
          query: { component: "full", scope_id: "target-a", scope_kind: "part" },
          requestId: "target-a",
        },
      ],
    ]);
    const replacement = new Map<string, Viewport3DFieldVectorEnvelope>([
      [
        "target-a",
        {
          ...previous.get("target-a")!,
          data: {
            ...previous.get("target-a")!.data,
            values: new Float64Array([4, 5, 6]),
          },
          etag: '"field-m-2"',
        },
      ],
    ]);

    expect(
      resolveViewport3DFieldVectorCollectionLastGood({
        current: replacement,
        previous,
        requests,
        status: "stale",
      }).get("target-a")?.etag,
    ).toBe('"field-m-1"');
    expect(
      resolveViewport3DFieldVectorCollectionLastGood({
        current: replacement,
        previous,
        requests,
        status: "ready",
      }).get("target-a")?.etag,
    ).toBe('"field-m-2"');
  });

  it("drops last-good data when a target changes quantity or scope identity", () => {
    const field = {
      dtype: "float64" as const,
      formatVersion: 3 as const,
      domainGenerationId: "generation-1",
      grid: [1, 1, 1] as [number, number, number],
      indexing: "full_domain" as const,
      nComp: 3,
      pointCount: 1,
      quantityId: "m",
      scopeId: "target-a",
      scopeKind: "part" as const,
      valueCount: 3,
      values: new Float64Array([1, 2, 3]),
    };
    const envelope: Viewport3DFieldVectorEnvelope = {
      data: field,
      etag: '"field-m-1"',
      responseMetadata: fieldResponseMetadata({
        domainGenerationId: "generation-1",
        quantityId: "m",
        scopeId: "target-a",
        scopeKind: "part",
      }),
      resourceKey: "field:m:target-a",
    };
    const previous = new Map([["target-a", envelope]]);
    const changedRequest = new Map([
      [
        "target-a",
        {
          consumers: ["target-a:vector-glyph"],
          quantityId: "H_demag",
          query: { component: "full", scope_id: "target-a", scope_kind: "part" },
          requestId: "target-a",
        },
      ],
    ]);

    expect(
      resolveViewport3DFieldVectorCollectionLastGood({
        current: null,
        previous,
        requests: changedRequest,
        status: "loading",
      }),
    ).toEqual(new Map());
    expect(
      resolveViewport3DFieldVectorCollectionLastGood({
        current: new Map([[
          "target-a",
          {
            ...envelope,
            data: { ...envelope.data, quantityId: "H_demag" },
          },
        ]]),
        previous,
        requests: changedRequest,
        status: "ready",
      }),
    ).toEqual(new Map());
    expect(
      resolveViewport3DFieldVectorCollectionLastGood({
        current: null,
        previous,
        requests: new Map([
          [
            "target-a",
            {
              ...changedRequest.get("target-a")!,
              quantityId: "m",
            },
          ],
        ]),
        status: "idle",
      }),
    ).toEqual(new Map());
    expect(
      viewport3DFieldVectorMatchesRequestIdentity(envelope, changedRequest.get("target-a")!),
    ).toBe(false);
  });

  it("rejects a last-good carrier whose generation or topology precondition is stale", () => {
    const envelope: Viewport3DFieldVectorEnvelope = {
      data: {
        dtype: "float64",
        formatVersion: 3,
        domainGenerationId: "generation-1",
        grid: [1, 1, 1],
        indexing: "full_domain",
        meshTopologyHash: "carrier-1",
        nComp: 3,
        pointCount: 1,
        quantityId: "H_demag",
        scopeId: "airbox",
        scopeKind: "airbox",
        valueCount: 3,
        values: new Float64Array([1, 2, 3]),
      },
      etag: '"field-h-1"',
      responseMetadata: fieldResponseMetadata({
        domainGenerationId: "generation-1",
        meshTopologyHash: "carrier-1",
        quantityId: "H_demag",
      }),
      resourceKey: "field:H_demag:airbox",
    };
    const request = {
      consumers: ["airbox:vector-glyph"],
      quantityId: "H_demag",
      query: {
        component: "full",
        expected_carrier_revision: "carrier-2",
        expected_generation_id: "generation-2",
        scope_kind: "airbox",
        scope_id: "airbox",
      },
      requestId: "airbox",
    };

    expect(viewport3DFieldVectorMatchesRequestIdentity(envelope, request)).toBe(
      false,
    );
  });

  it("loads collection members independently instead of atomically awaiting Promise.all", () => {
    const source = readFileSync(viewport3dResourcesSourceUrl, "utf8");
    const quantityCollectionSource = source.slice(
      source.indexOf("export function useViewport3DQuantityFieldVectors"),
      source.indexOf("export function useViewport3DPartFieldVectors"),
    );
    const partCollectionSource = source.slice(
      source.indexOf("export function useViewport3DPartFieldVectors"),
      source.indexOf("export function useViewport3DMeshQualityData"),
    );
    const airboxCollectionSource = source.slice(
      source.indexOf("export function useViewport3DAirboxFieldVectors"),
      source.indexOf("function isViewport3DAirboxFieldVectorRequestMap"),
    );

    expect(quantityCollectionSource).not.toContain("Promise.all(");
    expect(partCollectionSource).not.toContain("Promise.all(");
    expect(airboxCollectionSource).not.toContain("Promise.all(");
    expect(quantityCollectionSource).toContain("loadViewport3DFieldRequestsBounded(");
    expect(partCollectionSource).toContain("loadViewport3DFieldRequestsBounded(");
    expect(airboxCollectionSource).toContain("loadViewport3DFieldRequestsBounded(");
  });

  it("changes a collection resource identity when a stable target changes quantity or query", () => {
    const first = resolveViewport3DFieldVectorCollectionResourceKey("airbox", [
      resolveViewport3DFieldVectorResourceKey("m", {
        component: "full",
        max_samples: 1200,
        scope_id: "part:__air__",
        scope_kind: "airbox",
      }),
    ]);
    const second = resolveViewport3DFieldVectorCollectionResourceKey("airbox", [
      resolveViewport3DFieldVectorResourceKey("H_demag", {
        component: "full",
        max_samples: 1200,
        scope_id: "part:__air__",
        scope_kind: "airbox",
      }),
    ]);

    expect(first).not.toBe(second);
  });

  it("binds field data and response metadata from the same cache entry", () => {
    const cache = new ResourceCache<
      DecodedFieldVector,
      FieldVectorResponseMetadata
    >({ maxBytes: 128 });
    const field = {
      dtype: "float64",
      grid: [1, 1, 1],
      nComp: 3,
      pointCount: 1,
      quantityId: "m",
      valueCount: 3,
      values: new Float64Array(3),
    } as DecodedFieldVector;
    const metadata = fieldResponseMetadata();
    cache.set("field:m", {
      byteLength: 24,
      data: field,
      etag: '"field-1"',
      metadata,
    });

    expect(resolveCachedFieldVectorEnvelope(cache, "field:m", field)).toEqual({
      data: field,
      etag: '"field-1"',
      responseMetadata: metadata,
      resourceKey: "field:m",
    });
  });

  it("fails closed when revalidation replaces the cache entry before the resource commits", () => {
    const cache = new ResourceCache<
      DecodedFieldVector,
      FieldVectorResponseMetadata
    >({ maxBytes: 128 });
    const oldField = { values: new Float64Array([1]) } as DecodedFieldVector;
    const newField = { values: new Float64Array([2]) } as DecodedFieldVector;
    cache.set("field:m", {
      byteLength: 8,
      data: newField,
      etag: '"field-2"',
      metadata: fieldResponseMetadata({
        domainGenerationId: "generation-2",
      }),
    });

    expect(
      resolveCachedFieldVectorEnvelope(cache, "field:m", oldField),
    ).toBeNull();
    expect(
      resolveCachedFieldVectorEnvelope(cache, "field:H_eff", newField),
    ).toBeNull();
  });

  it("exposes bounded aggregate and exact-entry field cache diagnostics without decoded data", () => {
    const resourceKey = resolveViewport3DFieldVectorResourceKey("missing", {
      component: "full",
      scope_kind: "full",
    });

    const budget = getViewport3DFieldVectorCacheBudgetDiagnostics();
    expect(budget).toEqual({
      byteLength: expect.any(Number),
      entryCount: expect.any(Number),
      maxBytes: expect.any(Number),
    });
    expect(Number.isSafeInteger(budget.byteLength)).toBe(true);
    expect(Number.isSafeInteger(budget.entryCount)).toBe(true);
    expect(Number.isSafeInteger(budget.maxBytes)).toBe(true);
    expect(budget.byteLength).toBeGreaterThanOrEqual(0);
    expect(budget.entryCount).toBeGreaterThanOrEqual(0);
    expect(budget.maxBytes).toBeGreaterThan(0);
    const diagnostics = getViewport3DFieldVectorCacheEntryDiagnostics(resourceKey);
    expect(diagnostics).toEqual({
      byteLength: null,
      dataIdentityMatches: null,
      entryState: "missing",
      etag: null,
      key: resourceKey,
      responseMetadata: null,
      retainCount: 0,
    });
    expect(diagnostics).not.toHaveProperty("data");
  });

  it("integrates ready, inflight, retain, release, and bounded metadata without exposing field data", () => {
    const cache = new ResourceCache<
      DecodedFieldVector,
      FieldVectorResponseMetadata
    >({ maxBytes: 64 });
    const resourceKey = resolveViewport3DFieldVectorResourceKey("H_eff", {
      component: "full",
      scope_kind: "full",
    });
    const inflightRegistry = new WeakMap<
      object,
      ReadonlyMap<string, { requestId: string }>
    >();
    const longValue = "x".repeat(5_000);
    const responseMetadata: FieldVectorResponseMetadata = {
      component: longValue,
      domainGenerationId: null,
      encoding: "fmvp-v3",
      fieldIndexing: "full_domain",
      fieldRevision: "field-1",
      identityIssues: Array.from({ length: 25 }, (_, index) => ({
        field: `${longValue}-${index}`,
        headerValue: longValue,
        payloadValue: index,
      })),
      meshTopologyHash: "topology-1",
      nComp: 3,
      nodeIndexCount: 0,
      pointCount: 1,
      quantityId: "H_eff",
      scopeId: null,
      scopeKind: "full",
      snapshotId: null,
      valueCount: 3,
    };
    const fieldVector: DecodedFieldVector = {
      dtype: "float64",
      grid: [1, 1, 1],
      nComp: 3,
      pointCount: 1,
      quantityId: "m",
      valueCount: 3,
      values: new Float64Array([1, 2, 3]),
    };

    expect(
      inspectViewport3DFieldVectorCacheEntryDiagnostics(
        cache,
        resourceKey,
        inflightRegistry,
      ).entryState,
    ).toBe("missing");
    inflightRegistry.set(
      cache,
      new Map([[resourceKey, { requestId: "request-1" }]]),
    );
    expect(
      inspectViewport3DFieldVectorCacheEntryDiagnostics(
        cache,
        resourceKey,
        inflightRegistry,
      ).entryState,
    ).toBe("inflight");

    cache.set(resourceKey, {
      byteLength: 24,
      data: fieldVector,
      etag: '"field-1"',
      metadata: responseMetadata,
    });
    inflightRegistry.delete(cache);
    const release = cache.retain(resourceKey);
    const ready = inspectViewport3DFieldVectorCacheEntryDiagnostics(
      cache,
      resourceKey,
      inflightRegistry,
      fieldVector,
    );
    expect(ready).toMatchObject({
      byteLength: 24,
      dataIdentityMatches: true,
      entryState: "ready",
      etag: '"field-1"',
      key: resourceKey,
      retainCount: 1,
    });
    expect(ready).not.toHaveProperty("data");
    expect(ready.responseMetadata?.identityIssues).toHaveLength(20);
    expect(ready.responseMetadata?.component).toHaveLength(4_096);
    expect(ready.responseMetadata?.identityIssues[0]?.field).toHaveLength(4_096);
    expect(ready.responseMetadata?.identityIssues[0]?.headerValue).toHaveLength(
      4_096,
    );

    inflightRegistry.set(
      cache,
      new Map([[resourceKey, { requestId: "request-2" }]]),
    );
    expect(
      inspectViewport3DFieldVectorCacheEntryDiagnostics(
        cache,
        resourceKey,
        inflightRegistry,
      ),
    ).toMatchObject({ entryState: "inflight", retainCount: 1 });
    inflightRegistry.delete(cache);
    release();
    expect(
      inspectViewport3DFieldVectorCacheEntryDiagnostics(
        cache,
        resourceKey,
        inflightRegistry,
      ).retainCount,
    ).toBe(0);
  });

  it("does not associate replacement response metadata with a retained decoded payload", () => {
    const cache = new ResourceCache<
      DecodedFieldVector,
      FieldVectorResponseMetadata
    >({ maxBytes: 1_024 });
    const inflightRegistry = new WeakMap<object, ReadonlyMap<string, object>>();
    const resourceKey = "field:H_demag:object:sample";
    const retainedV2: DecodedFieldVector = {
      dtype: "float64",
      formatVersion: 2,
      grid: [1, 1, 1],
      indexing: "legacy_count_only",
      nComp: 3,
      pointCount: 1,
      quantityId: "H_demag",
      valueCount: 3,
      values: new Float64Array([1, 2, 3]),
    };
    const replacementV3: DecodedFieldVector = {
      ...retainedV2,
      domainGenerationId: "v3",
      formatVersion: 3,
      indexing: "full_domain",
      scopeId: "sample",
      scopeKind: "object",
    };
    cache.set(resourceKey, {
      byteLength: replacementV3.values.byteLength,
      data: replacementV3,
      etag: '"field:v3:full-domain"',
      metadata: fieldResponseMetadata({
        domainGenerationId: "v3",
        encoding: "FMVP;version=3",
        fieldIndexing: "full_domain",
        scopeId: "sample",
        scopeKind: "object",
      }),
    });

    expect(
      inspectViewport3DFieldVectorCacheEntryDiagnostics(
        cache,
        resourceKey,
        inflightRegistry,
        retainedV2,
      ),
    ).toMatchObject({
      dataIdentityMatches: false,
      etag: '"field:v3:full-domain"',
      responseMetadata: null,
    });
  });

  it("threads pauseLoad through field-vector resource hooks", () => {
    const source = readFileSync(viewport3dResourcesSourceUrl, "utf8");

    expect(source.match(/pauseLoad: options\.pauseLoad/g)?.length).toBe(4);
  });

  it("builds stable resource keys for scoped field vectors", () => {
    expect(
      resolveViewport3DFieldVectorResourceKey("m", {
        component: "full",
        max_samples: 512,
        scope_id: "part-1",
        scope_kind: "part",
      }),
    ).toBe(
      `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?component=full&max_samples=512&scope_id=part-1&scope_kind=part`,
    );
  });

  it("includes hysteresis snapshot ids in field vector resource keys", () => {
    expect(
      resolveViewport3DFieldVectorResourceKey("m", {
        component: "full",
        scope_kind: "full",
        snapshot_id: "hysteresis-stage-1-point-4",
        stage_id: "hysteresis-1",
      }),
    ).toBe(
      `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?component=full&scope_kind=full&snapshot_id=hysteresis-stage-1-point-4&stage_id=hysteresis-1`,
    );
  });

  it("includes hysteresis snapshot ids in target quantity field vector requests", () => {
    expect(
      resolveViewport3DQuantityFieldVectorResourceRequests(
        new Map([
          [
            "h_eff",
            {
              component: "full",
              scope_kind: "full",
              snapshot_id: "hysteresis_point_007",
              stage_id: "hysteresis-1",
            },
          ],
        ]),
      ),
    ).toEqual(
      new Map([
        [
          "component=full&quantity=H_eff&scope_kind=full&snapshot_id=hysteresis_point_007&stage_id=hysteresis-1",
          {
            key: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "H_eff")}?component=full&scope_kind=full&snapshot_id=hysteresis_point_007&stage_id=hysteresis-1`,
            quantityId: "H_eff",
            query: {
              component: "full",
              scope_kind: "full",
              snapshot_id: "hysteresis_point_007",
              stage_id: "hysteresis-1",
            },
            requestId:
              "component=full&quantity=H_eff&scope_kind=full&snapshot_id=hysteresis_point_007&stage_id=hysteresis-1",
          },
        ],
      ]),
    );
  });

  it("matches only field metadata resources for a fetched 3D quantity", () => {
    const mMetaKey = `${DATA_FIELD_META_PATH.replace(
      "{quantity_id}",
      "m",
    )}?component=x&scope_id=object%3Apermalloy_layer&scope_kind=object`;
    const hEffMetaKey = `${DATA_FIELD_META_PATH.replace(
      "{quantity_id}",
      "H_eff",
    )}?component=y&scope_kind=airbox`;
    const hEffVectorKey = `${DATA_FIELD_VECTOR_PATH.replace(
      "{quantity_id}",
      "H_eff",
    )}?component=full&scope_kind=airbox`;
    const partScalarRangesKey = `${DATA_FIELDS_PATH}#viewport-3d:part-scalar-ranges:${DATA_FIELD_META_PATH.replace(
      "{quantity_id}",
      "m",
    )}?component=x&scope_id=permalloy_layer&scope_kind=object|${DATA_FIELD_META_PATH.replace(
      "{quantity_id}",
      "H_eff",
    )}?component=magnitude&scope_id=airbox&scope_kind=part`;

    expect(viewport3DFieldMetaResourceMatchesQuantity(mMetaKey, "m")).toBe(true);
    expect(viewport3DFieldMetaResourceMatchesQuantity(hEffMetaKey, "h_eff")).toBe(
      true,
    );
    expect(
      viewport3DFieldMetaResourceMatchesQuantity(partScalarRangesKey, "m"),
    ).toBe(true);
    expect(
      viewport3DFieldMetaResourceMatchesQuantity(partScalarRangesKey, "H_eff"),
    ).toBe(true);
    expect(viewport3DFieldMetaResourceMatchesQuantity(hEffVectorKey, "h_eff")).toBe(
      false,
    );
    expect(viewport3DFieldMetaResourceMatchesQuantity(mMetaKey, "H_eff")).toBe(
      false,
    );
  });

  it("invalidates matching field metadata after a 3D field vector refresh", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const hEffMetaKey = `${DATA_FIELD_META_PATH.replace(
      "{quantity_id}",
      "H_eff",
    )}?component=z&scope_kind=airbox`;
    const mMetaKey = `${DATA_FIELD_META_PATH.replace(
      "{quantity_id}",
      "m",
    )}?component=z&scope_kind=full`;
    const hEffVectorKey = `${DATA_FIELD_VECTOR_PATH.replace(
      "{quantity_id}",
      "H_eff",
    )}?component=full&scope_kind=airbox`;

    resources.subscribe(hEffMetaKey, () => {});
    resources.subscribe(mMetaKey, () => {});
    resources.subscribe(hEffVectorKey, () => {});

    invalidateViewport3DFieldMetaResources(resources, "h_eff", "field-etag-9");

    expect(resources.getRevision(hEffMetaKey)).toBe("field-etag-9");
    expect(resources.getRevision(mMetaKey)).toBeNull();
    expect(resources.getRevision(hEffVectorKey)).toBeNull();
  });

  it("includes complex analysis field view and phase in field vector resource keys", () => {
    expect(
      resolveViewport3DFieldVectorResourceKey(
        "analysis:frequency-response:frequency-0003",
        {
          component: "full",
          phase_rad: 1.25,
          view: "phase_rotated_real",
        },
      ),
    ).toBe(
      `${DATA_FIELD_VECTOR_PATH.replace(
        "{quantity_id}",
        "analysis%3Afrequency-response%3Afrequency-0003",
      )}?component=full&phase_rad=1.25&view=phase_rotated_real`,
    );
  });

  it("includes eigen mode analysis field ids, view, and phase in field vector resource keys", () => {
    expect(
      resolveViewport3DFieldVectorResourceKey(
        "analysis:eigen:sample-0000:mode-0002",
        {
          component: "full",
          phase_rad: 0.5,
          view: "phase_rotated_real",
        },
      ),
    ).toBe(
      `${DATA_FIELD_VECTOR_PATH.replace(
        "{quantity_id}",
        "analysis%3Aeigen%3Asample-0000%3Amode-0002",
      )}?component=full&phase_rad=0.5&view=phase_rotated_real`,
    );
  });

  it("preserves analysis view and phase in the field-vector hook query", () => {
    const source = readFileSync(viewport3dResourcesSourceUrl, "utf8");

    expect(source).toContain("const phaseRad = fieldQuery.phase_rad ?? null;");
    expect(source).toContain("const stageId = fieldQuery.stage_id ?? null;");
    expect(source).toContain("const view = fieldQuery.view ?? null;");
    expect(source).toContain("phase_rad: phaseRad,");
    expect(source).toContain("stage_id: stageId,");
    expect(source).toContain("view,");
  });

  it("preserves explicit airbox mesh part ids in field vector resource keys", () => {
    expect(
      resolveViewport3DAirboxFieldVectorResourceKeys("h_demag", [
        { id: "airbox" },
        { id: "airbox-shell" },
      ], {
        component: "full",
        max_samples: 384,
        scope_kind: "full",
      }, airboxFieldCatalog),
    ).toEqual(
      new Map([
        [
          "airbox",
          `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "H_demag")}?component=full&max_samples=384&scope_id=airbox&scope_kind=airbox`,
        ],
        [
          "airbox-shell",
          `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "H_demag")}?component=full&max_samples=384&scope_id=airbox-shell&scope_kind=airbox`,
        ],
      ]),
    );
  });

  it("preserves explicit airbox field vector query scope ids", () => {
    expect(
      resolveViewport3DAirboxFieldVectorQuery({
        component: "full",
        max_samples: 384,
        scope_id: "part:__air__:1",
        scope_kind: "full",
      }),
    ).toEqual({
      component: "full",
      max_samples: 384,
      scope_id: "part:__air__:1",
      scope_kind: "airbox",
    });
  });

  it("does not build airbox field vector resource keys for magnetic-only quantities", () => {
    expect(
      resolveViewport3DAirboxFieldVectorResourceKeys("m", [{ id: "airbox" }]),
    ).toEqual(new Map());
    expect(
      resolveViewport3DAirboxFieldVectorResourceKeys("h_ex", [{ id: "airbox" }]),
    ).toEqual(new Map());
  });

  it("builds airbox field vector resource keys for H_eff", () => {
    expect(
      resolveViewport3DAirboxFieldVectorResourceKeys("h_eff", [
        { id: "airbox" },
      ], undefined, airboxFieldCatalog),
    ).toEqual(
      new Map([
        [
          "airbox",
          `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "H_eff")}?component=full&scope_id=airbox&scope_kind=airbox`,
        ],
      ]),
    );
  });

  it("keeps airbox field vector request keys and API queries in sync", () => {
    expect(
      resolveViewport3DAirboxFieldVectorResourceRequests("h_eff", [
        { id: "airbox" },
        { id: "airbox-shell" },
      ], {
        component: "full",
        max_samples: 384,
        scope_kind: "full",
      }, airboxFieldCatalog),
    ).toEqual(
      new Map([
        [
          "airbox",
          {
            key: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "H_eff")}?component=full&max_samples=384&scope_id=airbox&scope_kind=airbox`,
            quantityId: "H_eff",
            query: {
              component: "full",
              max_samples: 384,
              scope_id: "airbox",
              scope_kind: "airbox",
            },
          },
        ],
        [
          "airbox-shell",
          {
            key: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "H_eff")}?component=full&max_samples=384&scope_id=airbox-shell&scope_kind=airbox`,
            quantityId: "H_eff",
            query: {
              component: "full",
              max_samples: 384,
              scope_id: "airbox-shell",
              scope_kind: "airbox",
            },
          },
        ],
      ]),
    );
  });

  it("preserves generation and carrier preconditions in airbox requests", () => {
    const request = resolveViewport3DAirboxFieldVectorResourceRequests(
      "h_eff",
      [{ id: "airbox" }],
      {
        component: "full",
        expected_carrier_revision: "carrier-7",
        expected_generation_id: "generation-3",
        scope_kind: "full",
      },
      airboxFieldCatalog,
    ).get("airbox");

    expect(request).toMatchObject({
      query: {
        component: "full",
        expected_carrier_revision: "carrier-7",
        expected_generation_id: "generation-3",
        scope_id: "airbox",
        scope_kind: "airbox",
      },
    });
    expect(request?.key).toContain("expected_carrier_revision=carrier-7");
    expect(request?.key).toContain("expected_generation_id=generation-3");
  });

  it("builds scoped magnetic part field vector resource requests", () => {
    expect(
      resolveViewport3DPartFieldVectorResourceRequests(
        new Map([
          [
            "part-b",
            {
              quantityId: "h_eff",
              query: {
                component: "full",
                max_samples: 128,
                scope_kind: "full",
              },
            },
          ],
          [
            "part-a",
            {
              quantityId: "m",
              query: {
                component: "full",
                max_samples: 64,
                scope_kind: "full",
              },
            },
          ],
        ]),
      ),
    ).toEqual(
      new Map([
        [
          "part-a",
          {
            key: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?component=full&max_samples=64&scope_id=part-a&scope_kind=part`,
            quantityId: "m",
            query: {
              component: "full",
              max_samples: 64,
              scope_id: "part-a",
              scope_kind: "part",
            },
          },
        ],
        [
          "part-b",
          {
            key: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "H_eff")}?component=full&max_samples=128&scope_id=part-b&scope_kind=part`,
            quantityId: "H_eff",
            query: {
              component: "full",
              max_samples: 128,
              scope_id: "part-b",
              scope_kind: "part",
            },
          },
        ],
      ]),
    );
  });

  it("preserves scoped magnetic part query scope when the request planner provides it", () => {
    expect(
      resolveViewport3DPartFieldVectorResourceRequests(
        new Map([
          [
            "part-a",
            {
              quantityId: "m",
              query: {
                component: "full",
                scope_id: "part-a",
                scope_kind: "part",
              },
            },
          ],
        ]),
      ).get("part-a"),
    ).toEqual({
      key: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?component=full&scope_id=part-a&scope_kind=part`,
      quantityId: "m",
      query: {
        component: "full",
        scope_id: "part-a",
        scope_kind: "part",
      },
    });
  });

  it("preserves generation and carrier preconditions in part requests", () => {
    const request = resolveViewport3DPartFieldVectorResourceRequests(
      new Map([
        [
          "part-a",
          {
            quantityId: "m",
            query: {
              component: "full",
              expected_carrier_revision: "carrier-7",
              expected_generation_id: "generation-3",
              scope_kind: "full",
            },
          },
        ],
      ]),
    ).get("part-a");

    expect(request).toMatchObject({
      query: {
        component: "full",
        expected_carrier_revision: "carrier-7",
        expected_generation_id: "generation-3",
        scope_id: "part-a",
        scope_kind: "part",
      },
    });
    expect(request?.key).toContain("expected_carrier_revision=carrier-7");
    expect(request?.key).toContain("expected_generation_id=generation-3");
  });

  it("preserves scoped magnetic part request identity and consumers from planner requests", () => {
    expect(
      resolveViewport3DPartFieldVectorResourceRequests(
        new Map([
          [
            "part-a",
            {
              consumers: ["part-a:surface", "part-a:vector-glyph"],
              quantityId: "m",
              query: {
                component: "full",
                scope_id: "part-a",
                scope_kind: "part",
              },
              requestId: "component=full&quantity=m&scope_id=part-a&scope_kind=part",
            },
          ],
        ]),
      ).get("part-a"),
    ).toMatchObject({
      consumers: ["part-a:surface", "part-a:vector-glyph"],
      requestId: "component=full&quantity=m&scope_id=part-a&scope_kind=part",
    });
  });

  it("builds stable full-field keys for target-specific quantities", () => {
    expect(
      resolveViewport3DQuantityFieldVectorResourceKeys(["h_eff", "H_eff", "m"]),
    ).toEqual(
      new Map([
        [
          "H_eff",
          `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "H_eff")}?component=full&scope_kind=full`,
        ],
        [
          "m",
          `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?component=full&scope_kind=full`,
        ],
      ]),
    );
  });

  it("preserves target-specific field vector requests after canonicalization", () => {
    expect(
      resolveViewport3DQuantityFieldVectorResourceRequests(
        new Map([
          ["h_eff", { component: "full", scope_kind: "full" }],
          ["H_eff", { component: "magnitude", scope_kind: "full" }],
        ]),
      ),
    ).toEqual(
      new Map([
        [
          "component=full&quantity=H_eff&scope_kind=full",
          {
            key: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "H_eff")}?component=full&scope_kind=full`,
            quantityId: "H_eff",
            query: {
              component: "full",
              scope_kind: "full",
            },
            requestId: "component=full&quantity=H_eff&scope_kind=full",
          },
        ],
        [
          "component=magnitude&quantity=H_eff&scope_kind=full",
          {
            key: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "H_eff")}?component=magnitude&scope_kind=full`,
            quantityId: "H_eff",
            query: {
              component: "magnitude",
              scope_kind: "full",
            },
            requestId: "component=magnitude&quantity=H_eff&scope_kind=full",
          },
        ],
      ]),
    );
  });

  it("preserves generation and carrier preconditions in quantity requests", () => {
    const requests = resolveViewport3DQuantityFieldVectorResourceRequests(
      new Map([
        [
          "h_eff",
          {
            component: "full",
            expected_carrier_revision: "carrier-7",
            expected_generation_id: "generation-3",
            scope_kind: "full",
          },
        ],
      ]),
    );
    const request = Array.from(requests.values())[0];

    expect(request).toMatchObject({
      query: {
        component: "full",
        expected_carrier_revision: "carrier-7",
        expected_generation_id: "generation-3",
        scope_kind: "full",
      },
    });
    expect(request?.key).toContain("expected_carrier_revision=carrier-7");
    expect(request?.key).toContain("expected_generation_id=generation-3");
  });

  it("keeps same-quantity target-specific field vector requests separated by request identity", () => {
    expect(
      resolveViewport3DQuantityFieldVectorResourceRequests(
        new Map([
          [
            "H_eff:part-a",
            {
              consumers: ["part:a:surface"],
              quantityId: "H_eff",
              query: {
                component: "x",
                scope_id: "part:a",
                scope_kind: "part",
              },
              requestId:
                "component=x&quantity=H_eff&scope_id=part:a&scope_kind=part",
            },
          ],
          [
            "H_eff:part-b",
            {
              consumers: ["part:b:surface"],
              quantityId: "H_eff",
              query: {
                component: "x",
                scope_id: "part:b",
                scope_kind: "part",
              },
              requestId:
                "component=x&quantity=H_eff&scope_id=part:b&scope_kind=part",
            },
          ],
        ]),
      ),
    ).toEqual(
      new Map([
        [
          "component=x&quantity=H_eff&scope_id=part:a&scope_kind=part",
          {
            consumers: ["part:a:surface"],
            key: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "H_eff")}?component=x&scope_id=part%3Aa&scope_kind=part`,
            quantityId: "H_eff",
            query: {
              component: "x",
              scope_id: "part:a",
              scope_kind: "part",
            },
            requestId:
              "component=x&quantity=H_eff&scope_id=part:a&scope_kind=part",
          },
        ],
        [
          "component=x&quantity=H_eff&scope_id=part:b&scope_kind=part",
          {
            consumers: ["part:b:surface"],
            key: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "H_eff")}?component=x&scope_id=part%3Ab&scope_kind=part`,
            quantityId: "H_eff",
            query: {
              component: "x",
              scope_id: "part:b",
              scope_kind: "part",
            },
            requestId:
              "component=x&quantity=H_eff&scope_id=part:b&scope_kind=part",
          },
        ],
      ]),
    );
  });

  it("builds target-specific field vector keys from planner request objects", () => {
    expect(
      resolveViewport3DQuantityFieldVectorResourceRequests(
        new Map([
          [
            "H_eff",
            {
              consumers: ["part:a:surface", "part:a:vector-glyph"],
              quantityId: "H_eff",
              query: {
                component: "full",
                scope_kind: "full",
                snapshot_id: "hysteresis_point_007",
                stage_id: "hysteresis-1",
              },
              requestId:
                "component=full&quantity=H_eff&scope_kind=full&snapshot_id=hysteresis_point_007&stage_id=hysteresis-1",
            },
          ],
        ]),
      ),
    ).toEqual(
      new Map([
        [
          "component=full&quantity=H_eff&scope_kind=full&snapshot_id=hysteresis_point_007&stage_id=hysteresis-1",
          {
            key: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "H_eff")}?component=full&scope_kind=full&snapshot_id=hysteresis_point_007&stage_id=hysteresis-1`,
            consumers: ["part:a:surface", "part:a:vector-glyph"],
            quantityId: "H_eff",
            query: {
              component: "full",
              scope_kind: "full",
              snapshot_id: "hysteresis_point_007",
              stage_id: "hysteresis-1",
            },
            requestId:
              "component=full&quantity=H_eff&scope_kind=full&snapshot_id=hysteresis_point_007&stage_id=hysteresis-1",
          },
        ],
      ]),
    );
  });

  it("builds target-specific field vector keys with scalar components", () => {
    expect(
      resolveViewport3DQuantityFieldVectorResourceRequests(
        new Map([
          [
            "h_eff",
            {
              component: "magnitude",
              scope_kind: "full",
            },
          ],
          [
            "m",
            {
              component: "x",
              scope_kind: "full",
            },
          ],
        ]),
      ),
    ).toEqual(
      new Map([
        [
          "component=magnitude&quantity=H_eff&scope_kind=full",
          {
            key: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "H_eff")}?component=magnitude&scope_kind=full`,
            quantityId: "H_eff",
            query: {
              component: "magnitude",
              scope_kind: "full",
            },
            requestId: "component=magnitude&quantity=H_eff&scope_kind=full",
          },
        ],
        [
          "component=x&quantity=m&scope_kind=full",
          {
            key: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?component=x&scope_kind=full`,
            quantityId: "m",
            query: {
              component: "x",
              scope_kind: "full",
            },
            requestId: "component=x&quantity=m&scope_kind=full",
          },
        ],
      ]),
    );
  });

  it("keeps field vector runtime keys stable across field revisions", () => {
    const source = readFileSync(viewport3dResourcesSourceUrl, "utf8");

    expect(source).not.toContain("#fields=");
    expect(source).not.toContain("resolveRevisionedFieldVectorCacheKey");
  });

  it("uses cached binary data when the API reports not modified", async () => {
    const cache = new ResourceCache<string>({ maxBytes: 32 });
    cache.set("topology", {
      byteLength: 4,
      data: "cached",
      etag: '"topology-1"',
    });
    const request = vi.fn(
      async (etag?: string | null, signal?: AbortSignal) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        return {
          etag: etag ?? null,
          status: "not-modified" as const,
        };
      },
    );

    await expect(
      loadCachedBinaryResource(cache, "topology", request),
    ).resolves.toBe("cached");
    expect(request.mock.calls[0]?.[0]).toBe('"topology-1"');
    expect(request.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it("preserves field response metadata when a conditional request returns 304", async () => {
    const cache = new ResourceCache<string, { topologyHash: string }>({
      maxBytes: 32,
    });
    cache.set("field:m", {
      byteLength: 4,
      data: "cached",
      etag: '"field-1"',
      metadata: { topologyHash: "abc123" },
    });

    await loadCachedBinaryResource(cache, "field:m", async () => ({
      etag: '"field-1"',
      status: "not-modified",
    }));

    expect(cache.get("field:m")?.metadata).toEqual({ topologyHash: "abc123" });
  });

  it("keeps the last-good field vector when a refresh is temporarily not applicable", async () => {
    const cache = new ResourceCache<string>({ maxBytes: 32 });
    cache.set("field:m", {
      byteLength: 4,
      data: "last-good-field",
      etag: '"field-1"',
    });

    await expect(
      loadCachedBinaryResource(
        cache,
        "field:m",
        async () => ({ etag: null, status: "not-applicable" }),
        { retainCachedOnNotApplicable: true },
      ),
    ).resolves.toBe("last-good-field");

    expect(cache.peek("field:m")).toMatchObject({
      data: "last-good-field",
      etag: '"field-1"',
    });
  });

  it("clears non-field binary data when it becomes not applicable", async () => {
    const cache = new ResourceCache<string>({ maxBytes: 32 });
    cache.set("topology", {
      byteLength: 4,
      data: "old-topology",
      etag: '"topology-1"',
    });

    await expect(
      loadCachedBinaryResource(cache, "topology", async () => ({
        etag: null,
        status: "not-applicable",
      })),
    ).resolves.toBeNull();

    expect(cache.peek("topology")).toBeNull();
  });

  it("restores a cached binary entry when it was evicted during a 304 request", async () => {
    const cache = new ResourceCache<string>({ maxBytes: 8 });
    cache.set("topology", {
      byteLength: 4,
      data: "cached",
      etag: '"topology-1"',
    });
    const request = vi.fn(async (etag?: string | null) => {
      cache.set("field:m", {
        byteLength: 8,
        data: "other",
        etag: '"field-1"',
      });
      return {
        etag: etag ?? null,
        status: "not-modified" as const,
      };
    });

    await expect(
      loadCachedBinaryResource(cache, "topology", request),
    ).resolves.toBe("cached");

    expect(cache.peek("topology")).toMatchObject({
      data: "cached",
      etag: '"topology-1"',
    });
  });

  it("can reuse cached binary data without a conditional request", async () => {
    const cache = new ResourceCache<string>({ maxBytes: 32 });
    cache.set("field:m", {
      byteLength: 4,
      data: "cached-field",
      etag: '"field-1"',
    });
    const request = vi.fn(async () => ({
      byteLength: 5,
      data: "fresh",
      etag: '"field-2"',
      status: "ready" as const,
    }));

    await expect(
      loadCachedBinaryResource(cache, "field:m", request, {
        preferCached: true,
      }),
    ).resolves.toBe("cached-field");
    expect(request).not.toHaveBeenCalled();
  });

  it("treats cached binary data as fresh until a resource revision changes", () => {
    const cache = new ResourceCache<string>({ maxBytes: 32 });
    cache.set("field:m", {
      byteLength: 4,
      data: "cached-field",
      etag: '"field-1"',
    });

    expect(cachedBinaryResourceMatchesRevision(cache, "field:m", null)).toBe(
      true,
    );
    expect(
      cachedBinaryResourceMatchesRevision(cache, "field:m", '"field-1"'),
    ).toBe(true);
    expect(cachedBinaryResourceMatchesRevision(cache, "field:m", 2)).toBe(
      false,
    );
    expect(
      cachedBinaryResourceMatchesRevision(cache, "field:m", '"field-2"'),
    ).toBe(false);
  });

  it("stores decoded binary data returned by the API", async () => {
    const cache = new ResourceCache<string>({ maxBytes: 32 });

    await expect(
      loadCachedBinaryResource(cache, "field:m", async () => ({
        byteLength: 5,
        data: "fresh",
        etag: '"field-1"',
        status: "ready",
      })),
    ).resolves.toBe("fresh");

    expect(cache.get("field:m")).toMatchObject({
      data: "fresh",
      etag: '"field-1"',
    });
  });

  it("deduplicates concurrent binary loads for the same cache key", async () => {
    const cache = new ResourceCache<string>({ maxBytes: 32 });
    const request = vi.fn(async () => ({
      byteLength: 5,
      data: "fresh",
      etag: '"field-1"',
      status: "ready" as const,
    }));

    const [first, second] = await Promise.all([
      loadCachedBinaryResource(cache, "field:m", request),
      loadCachedBinaryResource(cache, "field:m", request),
    ]);

    expect(first).toBe("fresh");
    expect(second).toBe("fresh");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps a shared binary request alive until every consumer aborts", async () => {
    const cache = new ResourceCache<string>({ maxBytes: 32 });
    let resolveRequest!: (result: {
      byteLength: number;
      data: string;
      etag: string;
      status: "ready";
    }) => void;
    const pendingRequest = new Promise<{
      byteLength: number;
      data: string;
      etag: string;
      status: "ready";
    }>((resolve) => {
      resolveRequest = resolve;
    });
    const requestSignals: AbortSignal[] = [];
    const request = vi.fn((_etag?: string | null, signal?: AbortSignal) => {
      if (signal) requestSignals.push(signal);
      return pendingRequest;
    });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = loadCachedBinaryResource(cache, "field:m", request, {
      signal: firstController.signal,
    });
    const second = loadCachedBinaryResource(cache, "field:m", request, {
      signal: secondController.signal,
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(requestSignals[0]?.aborted).toBe(false);

    firstController.abort();
    expect(requestSignals[0]?.aborted).toBe(false);

    secondController.abort();
    expect(requestSignals[0]?.aborted).toBe(true);

    resolveRequest({
      byteLength: 5,
      data: "fresh",
      etag: '"field-1"',
      status: "ready",
    });
    await expect(Promise.all([first, second])).resolves.toEqual([
      "fresh",
      "fresh",
    ]);
  });

  it("retains oversized binary data as the current entry for future 304 reuse", async () => {
    const cache = new ResourceCache<string>({ maxBytes: 4 });
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        byteLength: 8,
        data: "large-topology",
        etag: '"large-1"',
        status: "ready" as const,
      })
      .mockResolvedValueOnce({
        etag: '"large-1"',
        status: "not-modified" as const,
      });

    await expect(
      loadCachedBinaryResource(cache, "topology", request),
    ).resolves.toBe("large-topology");
    await expect(
      loadCachedBinaryResource(cache, "topology", request),
    ).resolves.toBe("large-topology");

    expect(request.mock.calls[1]?.[0]).toBe('"large-1"');
    expect(request.mock.calls[1]?.[1]).toBeInstanceOf(AbortSignal);
    expect(cache.stats()).toEqual({ byteLength: 8, entryCount: 1 });
  });

  it("can inspect cached binary etags without refreshing LRU order", () => {
    const cache = new ResourceCache<string>({ maxBytes: 10 });
    cache.set("oldest", { byteLength: 4, data: "old", etag: '"old"' });
    cache.set("middle", { byteLength: 4, data: "mid", etag: '"mid"' });

    expect(cache.peek("oldest")?.etag).toBe('"old"');

    cache.set("newest", { byteLength: 4, data: "new", etag: '"new"' });

    expect(cache.peek("oldest")).toBeNull();
    expect(cache.peek("middle")?.etag).toBe('"mid"');
    expect(cache.peek("newest")?.etag).toBe('"new"');
  });
});
