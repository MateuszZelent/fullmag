import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { PlanarFieldMetaResource, PlanarFieldQuery } from "@/kernel/api/apiTypes";
import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { PlanarFieldLayer } from "@/modules/inspector/public";

import type { FieldMapRenderModel } from "../model/fieldMapRenderModel";
import type { PlanarCompositionFrame } from "../model/planarCompositionFrame";

const harness = vi.hoisted(() => ({
  metaQueries: [] as PlanarFieldQuery[],
  payloadEnabled: [] as boolean[],
  respond: (_query: PlanarFieldQuery): { data: unknown; error: Error | null } => ({ data: null, error: null }),
  buffers: [] as { frame: PlanarCompositionFrame | null; statusReason: string | null; payloadPending: boolean }[],
}));

vi.mock("@/kernel/resources/planarFieldResources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/kernel/resources/planarFieldResources")>();
  const idle = { data: null, error: null, status: "loading" };
  return {
    ...actual,
    planarFieldQueryFromMeta: (_quantity: string, _source: unknown, meta: { query: PlanarFieldQuery }) => ({ ok: true, query: meta.query }),
    usePlanarFieldMetaResource: (_quantity: string, _source: unknown, query: PlanarFieldQuery) => {
      harness.metaQueries.push(query);
      const { data, error } = harness.respond(query);
      return { data, error, status: error ? "error" : data ? "ready" : "loading" };
    },
    usePlanarScalarResource: (_q: string, _s: unknown, _query: unknown, options: { enabled?: boolean }) => {
      harness.payloadEnabled.push(options.enabled !== false);
      return idle;
    },
    usePlanarMaskResource: () => idle,
    usePlanarVectorResource: () => idle,
  };
});
vi.mock("@/kernel/resources/useSessionScopedResourceKey", () => ({
  useSessionScopedResourceKey: () => ({ resourceKey: "session" }),
}));
vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionStatusSelector: () => false,
}));
vi.mock("./PlanarCompositionBuffers", () => ({
  PlanarCompositionBuffers: (props: { frame: PlanarCompositionFrame | null; statusReason: string | null; payloadPending: boolean }) => {
    harness.buffers.push(props);
    return null;
  },
}));

const { PlanarCompositionSurface } = await import("./PlanarCompositionSurface");

function baseMeta(): PlanarFieldMetaResource {
  return {
    quantity_id: "H_demag", component: "magnitude", canonical_unit: "A/m",
    field_revision: "1", scene_revision: "1", generation_id: "domain-1", field_source: "live",
    frame: {
      origin_m: [0, 0, 0], u_axis: [1, 0, 0], v_axis: [0, 1, 0], normal: [0, 0, 1],
      bounds_uv_m: [-1e-8, 2e-8, 0, 1e-8], full_bounds_uv_m: [-5e-8, 5e-8, -5e-8, 5e-8],
    },
    operator: { kind: "plane_sample" }, resolution: [4, 4], etag: "base", observation_frame: null,
  } as unknown as PlanarFieldMetaResource;
}

/** A layer frame whose origin is offset by (1e-8, -2.5e-9) in the base plane. */
function layerMeta(query: PlanarFieldQuery) {
  return {
    ...baseMeta(),
    quantity_id: "m",
    frame: { ...baseMeta().frame, origin_m: [1e-8, -2.5e-9, 0] },
    query,
  };
}

function layer(id: string): PlanarFieldLayer {
  return {
    id, view_scope: { kind: "object", scope_id: id }, quantity_id: "m", component: "magnitude",
    colormap: "viridis", range: { mode: "auto", min: null, max: null }, raster_opacity: 1,
    raster_visible: true, vectors_visible: false,
    vector_style: { color_mode: "orientation", length_mode: "uniform", monochrome_color: "white", opacity: 1, scale: 1, thickness: 1 },
    visible: true,
  };
}

const cropQuery: PlanarFieldQuery = {
  component: "magnitude", quality: "interactive", resolution_x: 4, resolution_y: 4,
  window_u_min_m: "-1e-8", window_u_max_m: "2e-8", window_v_min_m: "0", window_v_max_m: "1e-8",
};

async function renderSurface(profiles: PlanarFieldLayer[]) {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(<PlanarCompositionSurface
    active
    baseMeta={baseMeta()}
    baseQuery={cropQuery}
    model={{ sampleIdentity: "base" } as unknown as FieldMapRenderModel}
    onRenderEvidence={() => undefined}
    profiles={profiles}
    source={{ kind: "default" }}
  />));
  return async () => { await act(async () => root.unmount()); dom.restore(); };
}

describe("field layers inside a crop window", () => {
  it("resamples each layer at crop resolution in its own frame", async () => {
    harness.metaQueries.length = 0; harness.payloadEnabled.length = 0; harness.buffers.length = 0;
    harness.respond = (query) => ({ data: layerMeta(query), error: null });
    const cleanup = await renderSurface([layer("film")]);
    try {
      // The first request learns the layer's frame offset without a window and
      // loads no payload; the next one carries the crop shifted into that frame.
      expect(harness.metaQueries[0]).not.toHaveProperty("window_u_min_m");
      const windowed = harness.metaQueries.at(-1)!;
      expect(Number(windowed.window_u_min_m)).toBeCloseTo(-2e-8, 18);
      expect(Number(windowed.window_u_max_m)).toBeCloseTo(1e-8, 18);
      expect(Number(windowed.window_v_min_m)).toBeCloseTo(2.5e-9, 18);
      expect(Number(windowed.window_v_max_m)).toBeCloseTo(1.25e-8, 18);
      expect(harness.payloadEnabled[0]).toBe(false);
      expect(harness.payloadEnabled.at(-1)).toBe(true);
    } finally { await cleanup(); }
  });

  it("draws a layer that misses the crop as empty, without an error banner", async () => {
    harness.metaQueries.length = 0; harness.payloadEnabled.length = 0; harness.buffers.length = 0;
    harness.respond = (query) => query.window_u_min_m === undefined
      ? { data: layerMeta(query), error: null }
      : { data: null, error: new Error("invalid_planar_window: window does not intersect the frame") };
    const cleanup = await renderSurface([layer("film")]);
    try {
      const last = harness.buffers.at(-1)!;
      expect(last.statusReason).toBeNull();
      expect(last.payloadPending).toBe(false);
      expect(last.frame?.overlays).toEqual([]);
    } finally { await cleanup(); }
  });

  it("keeps a layer's request identity when the parent re-renders equal inputs", async () => {
    // New-but-equal layer, mask and query objects on every parent render
    // rebuilt the layer model and published a new composite frame, which
    // re-rendered the parent again (idle 2D view, ~12 frames per second).
    harness.metaQueries.length = 0; harness.payloadEnabled.length = 0; harness.buffers.length = 0;
    harness.respond = (query) => ({ data: layerMeta(query), error: null });
    const dom = installSimulationPreparationTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    const render = () => act(async () => root.render(<PlanarCompositionSurface
      active
      baseMeta={baseMeta()}
      baseQuery={{ ...cropQuery }}
      model={{ sampleIdentity: "base" } as unknown as FieldMapRenderModel}
      onRenderEvidence={() => undefined}
      profiles={[layer("film")]}
      source={{ kind: "default" }}
      viewMasks={{ boundaries: true, bounds: true, contours: false, mesh: false, points: false, probes: true, raster: true, streamlines: false, vectors: false }}
    />));
    try {
      await render();
      const settled = harness.metaQueries.at(-1);
      await render();
      await render();
      expect(harness.metaQueries.at(-1)).toBe(settled);
    } finally { await act(async () => root.unmount()); dom.restore(); }
  });

  it("still reports other layer failures", async () => {
    harness.metaQueries.length = 0; harness.payloadEnabled.length = 0; harness.buffers.length = 0;
    harness.respond = () => ({ data: null, error: new Error("quantity unavailable") });
    const cleanup = await renderSurface([layer("film")]);
    try {
      expect(harness.buffers.at(-1)!.statusReason).toContain("quantity unavailable");
    } finally { await cleanup(); }
  });
});
