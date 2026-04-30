import { describe, expect, it, vi } from "vitest";
import { ResourceCache } from "../../../api/client/cache/ResourceCache";
import type { FieldBinaryResponse } from "../../../api/types";
import type { DecodedFieldVector } from "../../../api/codecs/types";
import {
  buildFieldVectorRequestKey,
  buildFieldVectorResourceKey,
  buildFieldVectorScopeToken,
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
  it("builds scope-aware stable keys", () => {
    const params = baseParams();

    expect(buildFieldVectorScopeToken("airbox", "air")).toBe("airbox:air");
    expect(buildFieldVectorScopeToken("full", null)).toBe("full:none");
    expect(buildFieldVectorRequestKey(params)).toBe(
      "field-vector:m:7:2:full:airbox:air",
    );
    expect(buildFieldVectorResourceKey(params)).toBe("field:2:m:7:full:airbox:air");
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
});
