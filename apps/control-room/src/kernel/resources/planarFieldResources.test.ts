import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  DATA_PLANAR_DEFAULT_FIELD_EMPTY_MASK_PATH,
  DATA_PLANAR_DEFAULT_FIELD_MESH_OVERLAY_PATH,
  DATA_PLANAR_DEFAULT_FIELD_PROBE_PATH,
  DATA_PLANAR_DEFAULT_FIELD_RENDER_PNG_PATH,
  DATA_PLANAR_DEFAULT_FIELD_SCALAR_PATH,
  DATA_PLANAR_DEFAULT_FIELD_VECTORS_PATH,
  DATA_PLANAR_FIELD_EMPTY_MASK_PATH,
  DATA_PLANAR_FIELD_META_PATH,
  DATA_PLANAR_FIELD_MESH_OVERLAY_PATH,
  DATA_PLANAR_FIELD_PROBE_PATH,
  DATA_PLANAR_FIELD_RENDER_PNG_PATH,
  DATA_PLANAR_FIELD_SCALAR_PATH,
  DATA_PLANAR_FIELD_VECTORS_PATH,
} from "../api/apiPaths";
import { planarFieldResourceKey } from "../api/fieldQueryIdentity";

import { ResourceCache } from "./ResourceCache";
import {
  loadCachedPlanarBinary,
  loadCachedPlanarScalar,
  planarFieldQueryFromMeta,
  resolvePlanarFieldResourceKey,
} from "./planarFieldResources";

describe("planar field resources", () => {
  const monitorSource = (monitorId: string) => ({
    kind: "monitor" as const,
    monitorId,
  });

  it("keeps default and monitor source families distinct even for a monitor id named default", () => {
    const defaultKey = planarFieldResourceKey("m", { kind: "default" }, {});
    const monitorKey = planarFieldResourceKey(
      "m",
      { kind: "monitor", monitorId: "default" },
      {},
    );

    expect(defaultKey).toContain("/planar-default/");
    expect(monitorKey).toContain("/planar-monitors/default/");
    expect(defaultKey).not.toBe(monitorKey);
  });

  const defaultRevisions = {
    carrier_revision: "304",
    field_revision: "404",
    mesh_revision: "303",
    monitor_revision: "202",
    scene_revision: "101",
  } as const;
  const metaLinks = (
    quantityId = "m",
    monitorId = "plane-1",
    origin = "",
    revisions: Record<keyof typeof defaultRevisions, string> = defaultRevisions,
  ) => {
    const canonicalSuffix =
      "?sample_token=planar-sample-v3%3Aexact&component=normal" +
      `&expected_scene_revision=${revisions.scene_revision}` +
      `&expected_monitor_revision=${revisions.monitor_revision}` +
      `&expected_mesh_revision=${revisions.mesh_revision}` +
      `&expected_carrier_revision=${revisions.carrier_revision}` +
      `&expected_field_revision=${revisions.field_revision}` +
      "&resolution_x=128&resolution_y=64" +
      "&scope_kind=monitor_target&quality=interactive&include_mesh=false";
    const link = (path: string) =>
      origin +
      path
        .replace("{quantity_id}", encodeURIComponent(quantityId))
        .replace("{monitor_id}", encodeURIComponent(monitorId)) +
      canonicalSuffix;
    return {
      empty_mask: link(DATA_PLANAR_FIELD_EMPTY_MASK_PATH),
      mesh_overlay: link(DATA_PLANAR_FIELD_MESH_OVERLAY_PATH),
      probe: link(DATA_PLANAR_FIELD_PROBE_PATH),
      render_png: link(DATA_PLANAR_FIELD_RENDER_PNG_PATH),
      scalar: link(DATA_PLANAR_FIELD_SCALAR_PATH),
      vectors: link(DATA_PLANAR_FIELD_VECTORS_PATH),
    };
  };
  const metaIdentity = (
    quantityId = "m",
    monitorId = "plane-1",
    origin = "",
    revisions: Record<keyof typeof defaultRevisions, string> = defaultRevisions,
  ) => ({
    ...revisions,
    links: metaLinks(quantityId, monitorId, origin, revisions),
    sample_token: "planar-sample-v3:exact",
    source: {
      kind: "monitor" as const,
      monitor_id: monitorId,
      monitor_hash: "sha256:monitor",
      monitor_revision: revisions.monitor_revision,
    },
  });

  const defaultMetaIdentity = () => {
    const suffix =
      "?sample_token=planar-sample-v3%3Adefault&component=normal" +
      "&expected_scene_revision=101" +
      "&expected_source_revision=202" +
      "&expected_mesh_revision=303" +
      "&expected_carrier_revision=304" +
      "&expected_field_revision=404" +
      "&resolution_x=128&resolution_y=64" +
      "&scope_kind=monitor_target&quality=interactive&include_mesh=false";
    const link = (path: string) =>
      path.replace("{quantity_id}", "m") + suffix;
    return {
      carrier_revision: "304",
      field_revision: "404",
      links: {
        empty_mask: link(DATA_PLANAR_DEFAULT_FIELD_EMPTY_MASK_PATH),
        mesh_overlay: link(DATA_PLANAR_DEFAULT_FIELD_MESH_OVERLAY_PATH),
        probe: link(DATA_PLANAR_DEFAULT_FIELD_PROBE_PATH),
        render_png: link(DATA_PLANAR_DEFAULT_FIELD_RENDER_PNG_PATH),
        scalar: link(DATA_PLANAR_DEFAULT_FIELD_SCALAR_PATH),
        vectors: link(DATA_PLANAR_DEFAULT_FIELD_VECTORS_PATH),
      },
      mesh_revision: "303",
      sample_token: "planar-sample-v3:default",
      scene_revision: "101",
      source: {
        default_slice_hash: "sha256:default",
        default_slice_revision: "202",
        domain_generation_id: "domain-1",
        kind: "default" as const,
      },
    };
  };

  it("derives default identity from default-family links and rejects a monitor-family request", () => {
    const meta = defaultMetaIdentity();
    const result = planarFieldQueryFromMeta("m", { kind: "default" }, meta);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.query).toMatchObject({
      expected_source_revision: "202",
      sample_token: "planar-sample-v3:default",
    });
    expect(planarFieldQueryFromMeta("m", monitorSource("default"), meta)).toMatchObject({
      ok: false,
    });
  });

  it("normalizes query order into one resource identity", () => {
    const first = planarFieldResourceKey("m /% żółć", monitorSource("plane/a"), {
      resolution_y: 64,
      component: "z",
      resolution_x: 128,
    });
    const second = planarFieldResourceKey("m /% żółć", monitorSource("plane/a"), {
      resolution_x: 128,
      resolution_y: 64,
      component: "z",
    });

    expect(first).toBe(second);
    expect(first).toBe(
      `${DATA_PLANAR_FIELD_META_PATH.replace("{quantity_id}", "m%20%2F%25%20%C5%BC%C3%B3%C5%82%C4%87").replace("{monitor_id}", "plane%2Fa")}?component=z&include_mesh=false&quality=interactive&resolution_x=128&resolution_y=64&scope_kind=monitor_target&vector_budget=0`,
    );
    expect(
      resolvePlanarFieldResourceKey(
        "m",
        monitorSource("plane/a"),
        { component: "z" },
        '"etag"',
        DATA_PLANAR_FIELD_SCALAR_PATH,
      ),
    ).toContain("#revision=%22etag%22");
  });

  it("keeps immutable sample tokens and exact revisions in binary cache identity", () => {
    const revisions = {
      expected_carrier_revision: "9007199254741001",
      expected_field_revision: "9007199254741002",
      expected_mesh_revision: "9007199254741003",
      expected_monitor_revision: "9007199254741004",
      expected_scene_revision: "9007199254741005",
    } as const;
    const first = planarFieldResourceKey("m", monitorSource("plane/a"), {
      ...revisions,
      sample_token: "planar-sample-v3:first",
    });
    const second = planarFieldResourceKey("m", monitorSource("plane/a"), {
      ...revisions,
      sample_token: "planar-sample-v3:second",
    });

    expect(first).not.toBe(second);
    expect(first).toContain("sample_token=planar-sample-v3%3Afirst");
    for (const [name, revision] of Object.entries(revisions)) {
      expect(first).toContain(`${name}=${revision}`);
    }
  });

  it("derives exact binary identity from valid same-origin metadata links", () => {
    const result = planarFieldQueryFromMeta(
      "m",
      monitorSource("plane-1"),
      metaIdentity("m", "plane-1", "http://fullmag.invalid"),
    );

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.query).toMatchObject({
      sample_token: "planar-sample-v3:exact",
      expected_scene_revision: "101",
      expected_monitor_revision: "202",
      expected_mesh_revision: "303",
      expected_carrier_revision: "304",
      expected_field_revision: "404",
      quality: "interactive",
      resolution_x: 128,
      resolution_y: 64,
      scope_kind: "monitor_target",
    });
  });

  it("accepts exact canonical paths for specially encoded ids", () => {
    const quantityId = "m /% żółć";
    const monitorId = "plane /% żółć";
    expect(
      planarFieldQueryFromMeta(
        quantityId,
        monitorSource(monitorId),
        metaIdentity(quantityId, monitorId),
      ),
    ).toMatchObject({ ok: true });
  });

  it.each([
    ["wrong quantity", "m", "plane-1", metaIdentity("H_eff", "plane-1")],
    ["wrong monitor", "m", "plane-1", metaIdentity("m", "plane-2")],
    ["external origin", "m", "plane-1", metaIdentity("m", "plane-1", "https://example.invalid")],
  ])("rejects %s without throwing", (_name, quantityId, monitorId, meta) => {
    expect(() =>
      planarFieldQueryFromMeta(quantityId, monitorSource(monitorId), meta),
    ).not.toThrow();
    expect(planarFieldQueryFromMeta(quantityId, monitorSource(monitorId), meta)).toMatchObject({
      ok: false,
    });
  });

  it("rejects an arbitrary shared prefix and identity disagreement", () => {
    const meta = metaIdentity();
    const falsePrefix = Object.fromEntries(
      Object.entries(meta.links).map(([kind, link]) => [
        kind,
        link.replace(
          DATA_PLANAR_FIELD_SCALAR_PATH.split("{quantity_id}")[0],
          "/not-the-planar-resource-family/",
        ),
      ]),
    ) as typeof meta.links;
    expect(planarFieldQueryFromMeta("m", monitorSource("plane-1"), {
      ...meta,
      links: falsePrefix,
    })).toMatchObject({
      ok: false,
    });
    expect(
      planarFieldQueryFromMeta("m", monitorSource("plane-1"), {
        ...meta,
        links: {
          ...meta.links,
          vectors: meta.links.vectors.replace(
            "expected_field_revision=404",
            "expected_field_revision=405",
          ),
        },
      }),
    ).toMatchObject({ ok: false });
  });

  it("returns a controlled error for malformed links", () => {
    const meta = metaIdentity();
    const malformedLinks = {
      ...meta.links,
      scalar: meta.links.scalar.slice(0, meta.links.scalar.indexOf("?")),
    };

    expect(() =>
      planarFieldQueryFromMeta("m", monitorSource("plane-1"), {
        ...meta,
        links: malformedLinks,
      }),
    ).not.toThrow();
    const result = planarFieldQueryFromMeta("m", monitorSource("plane-1"), {
      ...meta,
      links: malformedLinks,
    });
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.error.message).toContain("Canonical planar metadata link is missing");
  });

  it("accepts canonical zero and maximum u64 revisions", () => {
    const revisions = {
      carrier_revision: "18446744073709551615",
      field_revision: "0",
      mesh_revision: "18446744073709551615",
      monitor_revision: "0",
      scene_revision: "18446744073709551615",
    };
    expect(
      planarFieldQueryFromMeta(
        "m",
        monitorSource("plane-1"),
        metaIdentity("m", "plane-1", "", revisions),
      ),
    ).toMatchObject({ ok: true });
  });

  it.each([
    ["mismatch", "planar-sample-v3:other"],
    ["empty", ""],
    ["missing", undefined],
    ["invalid prefix", "other-sample:exact"],
  ])("rejects %s metadata sample token without throwing", (_name, sampleToken) => {
    const meta = {
      ...metaIdentity(),
      sample_token: sampleToken as string,
    };
    expect(() => planarFieldQueryFromMeta("m", monitorSource("plane-1"), meta)).not.toThrow();
    expect(planarFieldQueryFromMeta("m", monitorSource("plane-1"), meta)).toMatchObject({
      ok: false,
    });
  });

  it.each(["abc", "+1", "-1", " 1", "1 ", "01", "18446744073709551616"])(
    "rejects non-canonical link revision %j",
    (revision) => {
      const meta = metaIdentity();
      const links = Object.fromEntries(
        Object.entries(meta.links).map(([kind, link]) => [
          kind,
          link.replace("expected_field_revision=404", `expected_field_revision=${revision}`),
        ]),
      ) as typeof meta.links;
      expect(planarFieldQueryFromMeta("m", monitorSource("plane-1"), { ...meta, links })).toMatchObject({
        ok: false,
      });
    },
  );

  it.each([
    ["expected_carrier_revision", "304"],
    ["expected_field_revision", "404"],
    ["expected_mesh_revision", "303"],
    ["expected_monitor_revision", "202"],
    ["expected_scene_revision", "101"],
  ])("rejects non-canonical %s", (name, validRevision) => {
    const meta = metaIdentity();
    const links = Object.fromEntries(
      Object.entries(meta.links).map(([kind, link]) => [
        kind,
        link.replace(`${name}=${validRevision}`, `${name}=01`),
      ]),
    ) as typeof meta.links;
    expect(planarFieldQueryFromMeta("m", monitorSource("plane-1"), { ...meta, links })).toMatchObject({
      ok: false,
    });
  });

  it.each(
    Object.keys(defaultRevisions).filter((name) => name !== "monitor_revision") as Exclude<
      keyof typeof defaultRevisions,
      "monitor_revision"
    >[],
  )(
    "rejects non-canonical metadata revision %s",
    (name) => {
      const meta = { ...metaIdentity(), [name]: "01" };
      expect(planarFieldQueryFromMeta("m", monitorSource("plane-1"), meta)).toMatchObject({
        ok: false,
      });
    },
  );

  it("rejects a non-canonical source revision", () => {
    const meta = metaIdentity();
    expect(
      planarFieldQueryFromMeta("m", monitorSource("plane-1"), {
        ...meta,
        source: { ...meta.source, monitor_revision: "01" },
      }),
    ).toMatchObject({ ok: false });
  });

  it("rejects a 304 response when no matching cached payload exists", async () => {
    const cache = new ResourceCache<ArrayBuffer>({ maxBytes: 1024 });
    await expect(
      loadCachedPlanarBinary(cache, "missing", async () => ({
        etag: '"missing"',
        status: "not-modified",
      })),
    ).rejects.toThrow("returned 304 without cache entry");
  });

  it("reuses the cached payload and sends its etag", async () => {
    const cache = new ResourceCache<ArrayBuffer>({ maxBytes: 1024 });
    const payload = new Uint8Array([1, 2, 3]).buffer;
    cache.set("field", {
      byteLength: payload.byteLength,
      data: payload,
      etag: '"field-etag"',
    });
    const request = vi.fn(async () => ({
      etag: '"field-etag"',
      status: "not-modified" as const,
    }));

    await expect(loadCachedPlanarBinary(cache, "field", request)).resolves.toBe(
      payload,
    );
    expect(request).toHaveBeenCalledWith('"field-etag"');
  });

  it("returns the scalar response etag with the cached binary payload", async () => {
    const cache = new ResourceCache<ArrayBuffer>({ maxBytes: 1024 });
    const payload = new Uint8Array([1, 2, 3]).buffer;
    cache.set("field", {
      byteLength: payload.byteLength,
      data: payload,
      etag: '"scalar-current"',
    });

    await expect(
      loadCachedPlanarScalar(cache, "field", async () => ({
        etag: '"scalar-current"',
        status: "not-modified",
      })),
    ).resolves.toEqual({ data: payload, etag: '"scalar-current"' });
  });

  it("delegates inactive resources to the shared no-load hook policy", () => {
    const source = readFileSync(
      new URL("./planarFieldResources.ts", import.meta.url),
      "utf8",
    );
    const binaryHook = source.slice(
      source.indexOf("export function usePlanarFieldBinaryResource"),
      source.indexOf("export async function loadCachedPlanarBinary"),
    );

    expect(binaryHook).toContain("enabled: options.enabled");
    expect(binaryHook).toContain("return useResource<ArrayBuffer | null>");
  });
});
