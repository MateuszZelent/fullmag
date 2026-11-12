import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlanarFieldMetaResource, PlanarFieldProbeResource } from "@/kernel/api/apiTypes";
import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { PLANAR_OCCUPANCY } from "../model/planarOccupancy";
import {
  NODE_PROBE_DEBOUNCE_MS,
  NODE_PROBE_MAX_LAYERS,
  usePlanarNodeProbes,
  type PlanarFieldLayerRuntime,
  type PlanarNodeProbeResult,
} from "./usePlanarNodeProbes";

const loader = vi.hoisted(() => vi.fn());

vi.mock("@/kernel/resources/planarFieldResources", () => ({
  usePlanarProbeLoader: () => loader,
}));

function layer(id: string, occupied: boolean, shift: readonly [number, number] = [0, 0]): PlanarFieldLayerRuntime {
  return {
    bounds: [0, 2, 0, 2],
    id,
    label: `${id} · m`,
    mask: new Uint8Array(4).fill(occupied ? PLANAR_OCCUPANCY.occupied : PLANAR_OCCUPANCY.empty),
    meta: {} as PlanarFieldMetaResource,
    quantityId: "m",
    query: { sample_token: `planar-sample-v3:${id}`, window_u_min_m: "0", window_u_max_m: "2", window_v_min_m: "0", window_v_max_m: "2" },
    resolution: [2, 2],
    scale: 1e-3,
    shift,
    source: { kind: "default" },
    unit: "kA/m",
  };
}

function probe(nodeId: number, overrides: Partial<PlanarFieldProbeResource> = {}): PlanarFieldProbeResource {
  return {
    nearest_node: {
      in_plane_distance_m: 1e-10, kind: "fem_node", node_id: nodeId, normal_offset_m: 0,
      scalar: 2_000, u_m: 0.5, v_m: 0.5, vector: [1_000, 0, 0], world_m: [0, 0, 0],
    },
    nearest_node_status: "ok",
    occupancy: "occupied",
    scalar: 1_000,
    u_m: 0.5,
    v_m: 0.5,
    vector: [1_000, 0, 0],
    ...overrides,
  } as PlanarFieldProbeResource;
}

describe("usePlanarNodeProbes", () => {
  let dom: ReturnType<typeof installSimulationPreparationTestDom>;
  let root: ReturnType<typeof createRoot>;
  let results: PlanarNodeProbeResult[] = [];
  function Harness(props: Parameters<typeof usePlanarNodeProbes>[0]) {
    results = usePlanarNodeProbes(props);
    return null;
  }
  const render = (props: Parameters<typeof usePlanarNodeProbes>[0]) =>
    act(async () => { root.render(<Harness {...props} />); });

  beforeEach(() => {
    vi.useFakeTimers();
    loader.mockReset();
    dom = installSimulationPreparationTestDom();
    root = createRoot(dom.document.createElement("div") as unknown as Element);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    dom.restore();
    vi.useRealTimers();
  });

  it("probes only occupied layers, in list order, at most four, with nearest=node and the window", async () => {
    loader.mockResolvedValue(probe(1));
    const layers = [layer("a", true), layer("empty", false), layer("b", true, [1, 0]), layer("c", true), layer("d", true), layer("e", true)];
    await render({ enabled: true, layers, uv: { u_m: 1.5, v_m: 0.5 } });
    expect(results.map((result) => result.status)).toEqual(["loading", "loading", "loading", "loading"]);
    await act(async () => { vi.advanceTimersByTime(NODE_PROBE_DEBOUNCE_MS); });
    expect(loader).toHaveBeenCalledTimes(NODE_PROBE_MAX_LAYERS);
    expect(loader.mock.calls.map((call) => (call[2] as { sample_token: string }).sample_token))
      .toEqual(["a", "b", "c", "d"].map((id) => `planar-sample-v3:${id}`));
    expect(loader.mock.calls[1]![2]).toMatchObject({ nearest: "node", u_m: 0.5, v_m: 0.5, window_u_min_m: "0" });
    await act(async () => { await Promise.resolve(); });
    expect(results.map((result) => result.layerId)).toEqual(["a", "b", "c", "d"]);
    expect(results[1]).toMatchObject({
      node: { node_id: 1, scalar: 2, u_m: 1.5, vector: [1, 0, 0] },
      point: { scalar: 1, vector: [1, 0, 0] },
      status: "ok",
      unit: "kA/m",
    });
  });

  it("sends one request per layer for two moves 20 ms apart, for the second position", async () => {
    loader.mockResolvedValue(probe(1));
    const layers = [layer("a", true)];
    await render({ enabled: true, layers, uv: { u_m: 0.5, v_m: 0.5 } });
    await act(async () => { vi.advanceTimersByTime(20); });
    await render({ enabled: true, layers, uv: { u_m: 1.5, v_m: 1.5 } });
    await act(async () => { vi.advanceTimersByTime(NODE_PROBE_DEBOUNCE_MS); });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader.mock.calls[0]![2]).toMatchObject({ u_m: 1.5, v_m: 1.5 });
  });

  it("still probes when the parent re-renders equal layers during the debounce", async () => {
    // A busy 2D view rebuilds its layer objects on every render; the debounce
    // must follow the request identity, not object identity, or no probe is
    // ever sent (found in the browser: the readout stayed "Loading…").
    loader.mockResolvedValue(probe(1));
    const uv = { u_m: 0.5, v_m: 0.5 };
    for (let step = 0; step < 8; step += 1) {
      await render({ enabled: true, layers: [layer("a", true)], uv: { ...uv } });
      await act(async () => { vi.advanceTimersByTime(NODE_PROBE_DEBOUNCE_MS / 2); });
    }
    // Re-renders are still arriving; the probe for this position went out.
    expect(loader).toHaveBeenCalledTimes(1);
    await act(async () => { await Promise.resolve(); });
    expect(results.map((result) => result.status)).toEqual(["ok"]);
  });

  it("aborts the old request and drops its late answer", async () => {
    const answers: ((value: PlanarFieldProbeResource) => void)[] = [];
    const signals: AbortSignal[] = [];
    loader.mockImplementation((_q, _s, _query, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<PlanarFieldProbeResource>((resolve) => answers.push(resolve));
    });
    const layers = [layer("a", true)];
    await render({ enabled: true, layers, uv: { u_m: 0.5, v_m: 0.5 } });
    await act(async () => { vi.advanceTimersByTime(NODE_PROBE_DEBOUNCE_MS); });
    await render({ enabled: true, layers, uv: { u_m: 1.5, v_m: 1.5 } });
    expect(signals[0]!.aborted).toBe(true);
    await act(async () => { vi.advanceTimersByTime(NODE_PROBE_DEBOUNCE_MS); });
    await act(async () => { answers[0]!(probe(111)); await Promise.resolve(); });
    expect(results[0]?.status).toBe("loading");
    await act(async () => { answers[1]!(probe(222)); await Promise.resolve(); });
    expect(results[0]?.node?.node_id).toBe(222);
  });

  it("sends nothing while disabled", async () => {
    await render({ enabled: false, layers: [layer("a", true)], uv: { u_m: 0.5, v_m: 0.5 } });
    await act(async () => { vi.advanceTimersByTime(NODE_PROBE_DEBOUNCE_MS * 2); });
    expect(loader).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it("reports an averaging operator with the point value and no node", async () => {
    loader.mockResolvedValue(probe(1, { nearest_node: null, nearest_node_status: "unsupported_operator" }));
    await render({ enabled: true, layers: [layer("a", true)], uv: { u_m: 0.5, v_m: 0.5 } });
    await act(async () => { vi.advanceTimersByTime(NODE_PROBE_DEBOUNCE_MS); await Promise.resolve(); });
    expect(results[0]).toMatchObject({ node: null, point: { scalar: 1 }, status: "unsupported_operator" });
  });
});
