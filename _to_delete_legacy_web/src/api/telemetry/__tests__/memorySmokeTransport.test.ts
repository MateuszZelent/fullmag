/**
 * Minimal memory smoke tests for the transport layer.
 *
 * Goals:
 *   1. ResourceCache.estimateSize must NOT call JSON.stringify on cached typed arrays.
 *      A Float64Array(10_000_000) = 80 MB. If stringified it would be >300 MB of text and
 *      noticeably slow. We verify both the byte estimate and the absence of serialisation.
 *
 *   2. getFieldVectorInflightCount() must reach 0 after all requests settle.
 *      Protects against the "50 rapid quantity switches → inflight never drains" regression.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { ResourceCache } from "../../client/cache/ResourceCache";
import {
  buildFieldVectorResourceKey,
  getFieldVectorInflightCount,
  loadFieldVectorRequest,
  type FieldVectorRequestClient,
  type FieldVectorRequestParams,
} from "../../../hooks/resources/useFieldVector";
import type { FieldBinaryResponse } from "../../types";
import { decodeFieldVectorOffThread } from "../../codecs/decodeOffThread";

// ── ResourceCache typed-array smoke tests ────────────────────────────────────

vi.mock("../../codecs/decodeOffThread", () => ({
  decodeFieldVectorOffThread: vi.fn(async () => ({
    quantityId: "m",
    nComp: 3,
    grid: [1, 1, 1],
    pointCount: 1,
    valueCount: 3,
    dtype: "float64",
    values: new Float64Array([0, 0, 0]),
  })),
}));

describe("ResourceCache — large typed-array smoke", () => {
  it("estimates Float64Array(10_000_000) as ~80 MB without stringification", () => {
    const cache = new ResourceCache(200 * 1024 * 1024 /* 200 MB budget */);

    const ELEMENT_COUNT = 10_000_000;
    const EXPECTED_BYTES = ELEMENT_COUNT * 8; // Float64 = 8 bytes each

    // Trap: if estimateSize calls JSON.stringify this will throw.
    const arr = new Float64Array(ELEMENT_COUNT);
    Object.defineProperty(arr, "toJSON", {
      value: () => {
        throw new Error(
          "ResourceCache must NOT call JSON.stringify / toJSON on typed arrays",
        );
      },
      configurable: true,
    });

    cache.set("large-field", arr, 1);

    const stats = cache.getCacheStats();
    expect(stats.entryCount).toBe(1);
    expect(stats.totalBytes).toBe(EXPECTED_BYTES);
  });

  it("estimates a nested decoded field payload by typed-array byteLength", () => {
    const cache = new ResourceCache(200 * 1024 * 1024);

    const values = new Float64Array(10_000_000);
    const EXPECTED_MIN = values.byteLength; // 80 MB

    cache.set(
      "nested-field",
      {
        quantityId: "m",
        nComp: 3,
        grid: [100, 100, 1000],
        pointCount: 10_000_000,
        valueCount: 30_000_000,
        dtype: "float64",
        values,
        toJSON: () => {
          throw new Error(
            "ResourceCache must NOT stringify nested DecodedFieldVector",
          );
        },
      },
      1,
    );

    const stats = cache.getCacheStats();
    expect(stats.entryCount).toBe(1);
    // Must be at least the raw byte length of the typed array.
    expect(stats.totalBytes).toBeGreaterThanOrEqual(EXPECTED_MIN);
    // Must not balloon to string-representation size (>300 MB).
    expect(stats.totalBytes).toBeLessThan(100 * 1024 * 1024);
  });
});

// ── Field-vector inflight drain smoke test ───────────────────────────────────

function makeClient(
  getVectorResponse: FieldVectorRequestClient["fields"]["getVectorResponse"],
): FieldVectorRequestClient {
  return {
    fields: { getVectorResponse },
    getCache: () => new ResourceCache(),
  } as FieldVectorRequestClient;
}

function binaryResponse(): FieldBinaryResponse {
  return {
    buffer: new ArrayBuffer(16),
    etag: '"v1"',
    status: 200,
    headers: new Headers(),
  };
}

function params(quantityId: string, revision: number): FieldVectorRequestParams {
  return {
    quantityId,
    revision,
    component: "full",
    domainGenerationId: 1,
    scopeKind: "full",
    scopeId: null,
  };
}

describe("getFieldVectorInflightCount — drain smoke", () => {
  beforeEach(() => {
    vi.mocked(decodeFieldVectorOffThread).mockResolvedValue({
      quantityId: "m",
      nComp: 3,
      grid: [1, 1, 1],
      pointCount: 1,
      valueCount: 3,
      dtype: "float64",
      values: new Float64Array([0, 0, 0]),
    });
  });

  it("starts at 0 and remains 0 before any requests", () => {
    expect(getFieldVectorInflightCount()).toBe(0);
  });

  it("drains to 0 after N sequential requests complete", async () => {
    const client = makeClient(vi.fn(async () => binaryResponse()));

    const requests = Array.from({ length: 10 }, (_, i) =>
      loadFieldVectorRequest(client, params("m", i + 1)),
    );

    await Promise.all(requests.map((r) => r.promise.catch(() => undefined)));

    expect(getFieldVectorInflightCount()).toBe(0);
    requests.forEach((r) => r.release());
  });

  it("drains to 0 after rapid quantity switches (a→b→a pattern)", async () => {
    const client = makeClient(vi.fn(async () => binaryResponse()));

    // Simulate 20 rapid switches across two quantities: m (even) and phi (odd).
    const requests = Array.from({ length: 20 }, (_, i) => {
      const qId = i % 2 === 0 ? "m" : "phi";
      return loadFieldVectorRequest(client, params(qId, i + 1));
    });

    await Promise.all(requests.map((r) => r.promise.catch(() => undefined)));

    expect(getFieldVectorInflightCount()).toBe(0);
    requests.forEach((r) => r.release());
  });
});
