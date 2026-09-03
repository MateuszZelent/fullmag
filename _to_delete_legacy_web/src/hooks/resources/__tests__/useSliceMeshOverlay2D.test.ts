import { describe, expect, it, vi } from "vitest";

import { ResourceCache } from "../../../api/client/cache/ResourceCache";
import {
  buildDomainSliceMeshOverlayResourceKey,
  loadSliceMeshOverlay2D,
  mapDomainSliceMeshOverlayResponse,
  type SliceMeshOverlayClient,
} from "../useSliceMeshOverlay2D";
import type { MeshOverlay2DResponse } from "../../../api/types";

const RESPONSE: MeshOverlay2DResponse = {
  schema: "fullmag.domain_2d.mesh_overlay.v1",
  plane: "xy",
  cut_kind: "normalized",
  cut_world: 0.25,
  cut_norm: 0.25,
  u_axis: "x",
  v_axis: "y",
  normal_axis: "z",
  bounds: {
    u_min: 0,
    u_max: 1,
    v_min: 0,
    v_max: 1,
  },
  segments: [
    {
      a: [0, 0],
      b: [1, 0],
    },
    {
      a: [1, 0],
      b: [0, 1],
    },
  ],
  truncated: false,
  segment_count: 2,
  point_count: 0,
  topology_revision: 17,
  domain_generation_id: 42,
  etag: "\"mesh-1\"",
};

describe("useSliceMeshOverlay2D helpers", () => {
  it("maps backend response into chart overlay series data", () => {
    expect(mapDomainSliceMeshOverlayResponse(RESPONSE)).toEqual({
      topologyKey: "\"mesh-1\"",
      segments: RESPONSE.segments,
    });
  });

  it("caches mesh overlay responses by topology revision and query", async () => {
    const cache = new ResourceCache();
    const getSliceMeshOverlayResponse = vi.fn().mockResolvedValue({
      data: RESPONSE,
      status: 200,
      headers: new Headers({ ETag: "\"mesh-1\"" }),
    });
    const client: SliceMeshOverlayClient = {
      getCache: () => cache,
      domain: {
        getSliceMeshOverlayResponse,
      } as any,
    };
    const params = {
      domainGenerationId: 42,
      topologyRevision: 17,
      query: {
        plane: "xy" as const,
        cut_norm: 0.25,
      },
    };

    const first = await loadSliceMeshOverlay2D(client, params);
    const second = await loadSliceMeshOverlay2D(client, params);

    expect(first).toEqual(second);
    expect(getSliceMeshOverlayResponse).toHaveBeenCalledTimes(1);
    expect(
      cache.get<MeshOverlay2DResponse>(buildDomainSliceMeshOverlayResourceKey(params))?.eTag,
    ).toBe("\"mesh-1\"");
  });

  it("throws when the backend returns 304 without cached overlay data", async () => {
    const client: SliceMeshOverlayClient = {
      getCache: () => new ResourceCache(),
      domain: {
        getSliceMeshOverlayResponse: vi.fn().mockResolvedValue({
          data: null,
          status: 304,
          headers: new Headers(),
        }),
      } as any,
    };

    await expect(
      loadSliceMeshOverlay2D(client, {
        domainGenerationId: 42,
        topologyRevision: 17,
        query: { plane: "xy", cut_norm: 0.25 },
      }),
    ).rejects.toThrow("304 without cached data");
  });

  it("maps 304 responses to the cached overlay when cache data exists", async () => {
    const cache = new ResourceCache();
    const params = {
      domainGenerationId: 42,
      topologyRevision: 17,
      query: { plane: "xy" as const, cut_norm: 0.25 },
    };
    cache.set(
      buildDomainSliceMeshOverlayResourceKey(params),
      RESPONSE,
      params.topologyRevision,
      params.domainGenerationId,
      "\"mesh-1\"",
    );
    const client: SliceMeshOverlayClient = {
      getCache: () => cache,
      domain: {
        getSliceMeshOverlayResponse: vi.fn().mockResolvedValue({
          data: null,
          status: 304,
          headers: new Headers(),
        }),
      } as any,
    };

    await expect(loadSliceMeshOverlay2D(client, params)).resolves.toEqual({
      topologyKey: "\"mesh-1\"",
      segments: RESPONSE.segments,
    });
  });

  it("keys cached overlays by topology revision and cut query", () => {
    const base = {
      domainGenerationId: 42,
      topologyRevision: 17,
      query: { plane: "xy" as const, cut_norm: 0.25 },
    };

    expect(buildDomainSliceMeshOverlayResourceKey({ ...base, topologyRevision: 18 })).not.toBe(
      buildDomainSliceMeshOverlayResourceKey(base),
    );
    expect(
      buildDomainSliceMeshOverlayResourceKey({
        ...base,
        query: { plane: "xy" as const, cut_world: 0.25 },
      }),
    ).not.toBe(buildDomainSliceMeshOverlayResourceKey(base));
  });
});
