import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResourceCache } from "../../../api/client/cache/ResourceCache";
import type { FieldBinaryResponse } from "../../../api/types";
import type { DecodedFieldVector } from "../../../api/codecs/types";
import { decodeFieldVectorOffThread } from "../../../api/codecs/decodeOffThread";
import {
  buildFieldVectorRequestKey,
  buildFieldVectorResourceKey,
  buildFieldVectorScopeToken,
  getFieldVectorInflightCount,
  loadFieldVectorRequest,
  type FieldVectorRequestClient,
  type FieldVectorRequestParams,
} from "../useFieldVector";

const decodedField: DecodedFieldVector = {
  quantityId: "m",
  nComp: 3,
  grid: [1, 1, 1],
  pointCount: 1,
  valueCount: 3,
  dtype: "float64",
  values: new Float64Array([1, 2, 3]),
};

vi.mock("../../../api/codecs/decodeOffThread", () => ({
  decodeFieldVectorOffThread: vi.fn(async () => ({
    quantityId: "m",
    nComp: 3,
    grid: [1, 1, 1],
    pointCount: 1,
    valueCount: 3,
    dtype: "float64",
    values: new Float64Array([1, 2, 3]),
  })),
}));

const decodeFieldVectorOffThreadMock = vi.mocked(decodeFieldVectorOffThread);

function baseParams(): FieldVectorRequestParams {
  return {
    quantityId: "m",
    revision: 7,
    component: "full",
    domainGenerationId: 2,
    scopeKind: "airbox",
    scopeId: "air",
  };
}

function createClient(
  getVectorResponse: FieldVectorRequestClient["fields"]["getVectorResponse"],
): FieldVectorRequestClient {
  const cache = new ResourceCache();
  return {
    fields: { getVectorResponse },
    getCache: () => cache,
  } as FieldVectorRequestClient;
}

function binaryResponse(buffer = new ArrayBuffer(16)): FieldBinaryResponse {
  return {
    buffer,
    etag: "\"next\"",
    status: 200,
    headers: new Headers(),
  };
}

describe("useFieldVector request helpers", () => {
  beforeEach(() => {
    decodeFieldVectorOffThreadMock.mockClear();
    decodeFieldVectorOffThreadMock.mockResolvedValue({
      quantityId: "m",
      nComp: 3,
      grid: [1, 1, 1],
      pointCount: 1,
      valueCount: 3,
      dtype: "float64",
      values: new Float64Array([1, 2, 3]),
    });
  });

  it("builds scope-aware stable keys", () => {
    const params = baseParams();

    expect(buildFieldVectorScopeToken("airbox", "air")).toBe("airbox:air");
    expect(buildFieldVectorScopeToken("full", null)).toBe("full:none");
    expect(buildFieldVectorRequestKey(params)).toBe(
      "field-vector:m:7:2:full:airbox:air",
    );
    expect(buildFieldVectorResourceKey(params)).toBe("field:2:m:0:full:airbox:air");
  });

  it("keeps the decoded resource cache key stable across field revisions", () => {
    const first = baseParams();
    const second = { ...first, revision: first.revision + 1 };

    expect(buildFieldVectorRequestKey(first)).not.toBe(buildFieldVectorRequestKey(second));
    expect(buildFieldVectorResourceKey(first)).toBe(buildFieldVectorResourceKey(second));
  });

  it("reuses cached decoded fields without fetching", async () => {
    const getVectorResponse = vi.fn();
    const client = createClient(getVectorResponse);
    const params = baseParams();
    client
      .getCache()
      .set(buildFieldVectorResourceKey(params), decodedField, params.revision);

    const request = loadFieldVectorRequest(client, params);

    await expect(request.promise).resolves.toBe(decodedField);
    expect(getVectorResponse).not.toHaveBeenCalled();
  });

  it("deduplicates identical inflight requests", async () => {
    const getVectorResponse = vi.fn(async () => binaryResponse());
    const client = createClient(getVectorResponse);
    const params = baseParams();

    const first = loadFieldVectorRequest(client, params);
    const second = loadFieldVectorRequest(client, params);

    expect(getVectorResponse).toHaveBeenCalledTimes(1);
    await expect(first.promise).resolves.toEqual(decodedField);
    await expect(second.promise).resolves.toEqual(decodedField);
    first.release();
    second.release();
  });

  it("records the configured audit resource label for uncached fetches", async () => {
    vi.stubGlobal("window", {});
    const getVectorResponse = vi.fn(async () => binaryResponse());
    const client = createClient(getVectorResponse);

    const request = loadFieldVectorRequest(client, {
      ...baseParams(),
      auditResource: "field-vector-shader",
    });

    expect((window as any).__FULLMAG_AUDIT__.resourceFetches).toMatchObject({
      "field-vector-shader": 1,
    });
    await request.promise;
    request.release();
    vi.unstubAllGlobals();
  });

  it("aborts an inflight fetch when the last consumer releases it", () => {
    let signal: AbortSignal | undefined;
    const getVectorResponse = vi.fn((_quantityId, _vectorOptions, opts) => {
      signal = opts?.signal;
      return new Promise<FieldBinaryResponse>(() => undefined);
    });
    const client = createClient(getVectorResponse);

    const request = loadFieldVectorRequest(client, baseParams());
    expect(signal?.aborted).toBe(false);

    request.release();

    expect(signal?.aborted).toBe(true);
  });

  it("keeps a shared inflight fetch alive when one consumer releases twice", () => {
    let signal: AbortSignal | undefined;
    const getVectorResponse = vi.fn((_quantityId, _vectorOptions, opts) => {
      signal = opts?.signal;
      return new Promise<FieldBinaryResponse>(() => undefined);
    });
    const client = createClient(getVectorResponse);
    const params = baseParams();

    const first = loadFieldVectorRequest(client, params);
    const second = loadFieldVectorRequest(client, params);

    first.release();
    first.release();
    expect(signal?.aborted).toBe(false);

    second.release();
    expect(signal?.aborted).toBe(true);
  });

  it("does not cache a decoded response after all consumers released it", async () => {
    let resolveDecode:
      | ((value: DecodedFieldVector) => void)
      | undefined;
    decodeFieldVectorOffThreadMock.mockReturnValueOnce(
      new Promise<DecodedFieldVector>((resolve) => {
        resolveDecode = resolve;
      }),
    );
    const getVectorResponse = vi.fn(async () => binaryResponse(new ArrayBuffer(16)));
    const client = createClient(getVectorResponse);
    const params = baseParams();
    const resourceKey = buildFieldVectorResourceKey(params);

    const request = loadFieldVectorRequest(client, params);
    await vi.waitFor(() => expect(decodeFieldVectorOffThreadMock).toHaveBeenCalled());

    request.release();
    resolveDecode?.(decodedField);

    await expect(request.promise).rejects.toThrow(/aborted/i);
    expect(client.getCache().get(resourceKey)).toBeNull();
  });
});

describe("getFieldVectorInflightCount", () => {
  beforeEach(() => {
    decodeFieldVectorOffThreadMock.mockClear();
    decodeFieldVectorOffThreadMock.mockResolvedValue(decodedField);
  });

  it("returns 0 when no requests are in flight", () => {
    expect(getFieldVectorInflightCount()).toBe(0);
  });

  it("increases while a fetch is pending and returns to 0 after completion", async () => {
    let resolveResponse!: (v: FieldBinaryResponse) => void;
    const getVectorResponse = vi.fn(
      () => new Promise<FieldBinaryResponse>((res) => { resolveResponse = res; }),
    );
    const client = createClient(getVectorResponse);
    const params = baseParams();

    const request = loadFieldVectorRequest(client, params);
    expect(getFieldVectorInflightCount()).toBe(1);

    resolveResponse(binaryResponse());
    await request.promise;
    expect(getFieldVectorInflightCount()).toBe(0);
    request.release();
  });
});
