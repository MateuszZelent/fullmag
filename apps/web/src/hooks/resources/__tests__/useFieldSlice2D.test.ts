import { describe, expect, it, vi } from "vitest";

import { ResourceCache } from "../../../api/client/cache/ResourceCache";
import {
  __fieldSliceDecodeInternals,
  buildFieldSliceRequestKey,
  getFieldSliceInflightCount,
  loadFieldSliceRequest,
  type FieldSliceRequestClient,
} from "../useFieldSlice2D";
import type { FieldSliceMeta } from "../../../api/types";

function buildFmvpBuffer(values: number[], nComp: number): ArrayBuffer {
  const headerBytes = 48;
  const buffer = new ArrayBuffer(headerBytes + values.length * 8);
  const view = new DataView(buffer);

  // "FMVP"
  view.setUint8(0, 0x46);
  view.setUint8(1, 0x4d);
  view.setUint8(2, 0x56);
  view.setUint8(3, 0x50);
  // nComp (codec convention)
  view.setUint16(6, nComp, true);
  // elementCount at offset 12 (FMVP v2)
  view.setUint32(12, values.length, true);

  const payload = new Float64Array(buffer, headerBytes, values.length);
  payload.set(values);
  return buffer;
}

const META: FieldSliceMeta = {
  quantity_id: "m",
  plane: "xy",
  component: "x",
  cut_kind: "normalized",
  cut_norm: 0.5,
  cut_world: null,
  field_revision: 11,
  domain_generation_id: 0,
  sampling_method: "fdm_nearest",
  etag: "\"meta\"",
  slice_revision: "meta:token",
  x_pixels: 2,
  y_pixels: 2,
  grid: {
    x_size: 2,
    y_size: 2,
    point_count: 4,
  },
  bounds: null,
  scalar: {
    available: true,
    n_comp: 1,
    point_count: 4,
    min: -2,
    max: 4,
    etag: "\"scalar\"",
    href: "/scalar",
  },
  arrows: {
    available: true,
    n_comp: 2,
    point_count: 2,
    min: null,
    max: null,
    etag: "\"arrows\"",
    href: "/arrows",
  },
};

describe("useFieldSlice2D decode helpers", () => {
  it("decodes scalar FMVP using elementCount at byte offset 12", () => {
    const values = [1, -2, 3, 4];
    const buffer = buildFmvpBuffer(values, 1);
    const decoded = __fieldSliceDecodeInternals.decodeSliceScalar(buffer, META);

    expect(decoded.values.length).toBe(4);
    expect(Array.from(decoded.values)).toEqual(values);
    expect(decoded.xPixels).toBe(2);
    expect(decoded.yPixels).toBe(2);
    expect(decoded.min).toBe(-2);
    expect(decoded.max).toBe(4);
  });

  it("decodes arrow payload as FMVP v2 Float64Array with nComp=2", () => {
    const values = [0.25, -0.5, 1.0, 2.0, -3.0, 4.5];
    const buffer = buildFmvpBuffer(values, 2);
    const decoded = __fieldSliceDecodeInternals.decodeSliceArrows(buffer);

    expect(decoded.values).toBeInstanceOf(Float64Array);
    expect(Array.from(decoded.values)).toEqual(values);
    expect(decoded.arrowCount).toBe(3);
  });
});

describe("field slice request lifecycle", () => {
  it("dedupes matching inflight slice requests and aborts after the last release", () => {
    const cache = new ResourceCache();
    let signal: AbortSignal | null = null;
    const client: FieldSliceRequestClient = {
      getCache: () => cache,
      fields: {
        getSliceMeta: vi.fn((_quantityId, _query, opts) => {
          signal = opts?.signal ?? null;
          return new Promise<FieldSliceMeta>(() => undefined);
        }),
        getSliceScalarResponse: vi.fn(),
        getSliceArrowsResponse: vi.fn(),
      } as any,
    };
    const params = {
      quantityId: `m-${Date.now()}`,
      fieldRevision: 11,
      domainGenerationId: 7,
      query: { plane: "xy" as const, component: "x" as const, cut_norm: 0.5 },
    };

    const requestA = loadFieldSliceRequest(client, params);
    const requestB = loadFieldSliceRequest(client, params);

    expect(requestA.key).toBe(buildFieldSliceRequestKey(params));
    expect(requestB.key).toBe(requestA.key);
    expect(client.fields.getSliceMeta).toHaveBeenCalledTimes(1);
    expect(getFieldSliceInflightCount()).toBe(1);

    requestA.release();
    expect(signal?.aborted).toBe(false);
    expect(getFieldSliceInflightCount()).toBe(1);

    requestB.release();
    expect(signal?.aborted).toBe(true);
    expect(getFieldSliceInflightCount()).toBe(0);
  });

  it("caches decoded scalar and arrow slice payloads by revision and query", async () => {
    const cache = new ResourceCache();
    const scalarBuffer = buildFmvpBuffer([1, 2, 3, 4], 1);
    const arrowBuffer = buildFmvpBuffer([0, 1, 2, 3], 2);
    const client: FieldSliceRequestClient = {
      getCache: () => cache,
      fields: {
        getSliceMeta: vi.fn().mockResolvedValue(META),
        getSliceScalarResponse: vi.fn().mockResolvedValue({
          buffer: scalarBuffer,
          etag: "\"scalar-1\"",
          status: 200,
          headers: new Headers(),
        }),
        getSliceArrowsResponse: vi.fn().mockResolvedValue({
          buffer: arrowBuffer,
          etag: "\"arrows-1\"",
          status: 200,
          headers: new Headers(),
        }),
      } as any,
    };
    const params = {
      quantityId: "m",
      fieldRevision: 11,
      domainGenerationId: 7,
      query: {
        plane: "xy" as const,
        component: "x" as const,
        cut_norm: 0.5,
        include_arrows: true,
      },
    };

    const requestA = loadFieldSliceRequest(client, params);
    const resultA = await requestA.promise;
    requestA.release();
    const requestB = loadFieldSliceRequest(client, params);
    const resultB = await requestB.promise;
    requestB.release();

    expect(Array.from(resultA.scalar.values)).toEqual([1, 2, 3, 4]);
    expect(resultA.arrows?.arrowCount).toBe(2);
    expect(resultB).toBe(resultA);
    expect(client.fields.getSliceMeta).toHaveBeenCalledTimes(1);
    expect(client.fields.getSliceScalarResponse).toHaveBeenCalledTimes(1);
    expect(client.fields.getSliceArrowsResponse).toHaveBeenCalledTimes(1);
  });
});
