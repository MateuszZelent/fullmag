import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  DATA_FIELDS_PATH,
  DATA_FIELD_META_PATH,
  DATA_FIELD_VECTOR_PATH,
} from "@/kernel/api/apiPaths";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { ResourceCache } from "@/kernel/resources/ResourceCache";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";

import {
  cachedBinaryResourceMatchesRevision,
  invalidateViewport3DFieldMetaResources,
  loadCachedBinaryResource,
  resolveViewport3DAirboxFieldVectorQuery,
  resolveViewport3DAirboxFieldVectorResourceKeys,
  resolveViewport3DAirboxFieldVectorResourceRequests,
  resolveViewport3DFieldVectorResourceKey,
  resolveViewport3DPartFieldVectorResourceRequests,
  resolveViewport3DQuantityFieldVectorResourceRequests,
  resolveViewport3DQuantityFieldVectorResourceKeys,
  viewport3DFieldMetaResourceMatchesQuantity,
} from "./viewport3dResources";

const viewport3dResourcesSourceUrl = new URL(
  "./viewport3dResources.ts",
  import.meta.url,
);

describe("viewport3dResources", () => {
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
      }),
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
      ]),
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
      }),
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
            key: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "H_eff")}?component=x&scope_id=a&scope_kind=part`,
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
            key: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "H_eff")}?component=x&scope_id=b&scope_kind=part`,
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

  it("skips binary requests while a caller-level request pause is active", async () => {
    const cache = new ResourceCache<string>({ maxBytes: 32 });
    const request = vi.fn(async () => ({
      byteLength: 5,
      data: "fresh",
      etag: '"field-2"',
      status: "ready" as const,
    }));

    await expect(
      loadCachedBinaryResource(cache, "field:m", request, {
        pauseRequest: () => true,
      }),
    ).resolves.toBeNull();
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
