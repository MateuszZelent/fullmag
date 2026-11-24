import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";

import {
  useViewport3DChunkedScalarColors,
  type Viewport3DChunkedScalarColorResult,
} from "./hooks/useViewport3DChunkedScalarColors";
import * as colorScheduler from "./viewport3dColorTransformScheduler";
import { disposeViewport3DColorTransformWorker } from "./viewport3dColorTransformScheduler";
import {
  buildViewport3DTopologyRenderModel,
  type Viewport3DFieldVector,
} from "./viewport3dRenderModel";

it("completes large saved color builds and changes components, ranges and sparse supports", async () => {
  const count = 50_004;
  const topology = buildViewport3DTopologyRenderModel({
    nodeCount: count, elementCount: 0, boundaryFaceCount: 0,
    positions: new Float64Array(count * 3), indices: new Uint32Array(),
    elementMarkers: new Uint32Array(), boundaryFaces: new Uint32Array(),
    boundaryMarkers: new Uint32Array(),
  }, [], [], new Map())!;
  const values = new Float64Array(count * 3);
  for (let node = 0; node < count; node += 1) {
    values[node * 3] = node;
    values[node * 3 + 1] = node + 1;
  }
  let field: Viewport3DFieldVector = {
    dtype: "float64", grid: [count, 1, 1], nComp: 3, pointCount: count,
    quantityId: "J_charge", valueCount: values.length, values,
  };
  let scope = "saved:first";
  let modes = new Set(["x"]);
  let palette = "viridis";
  let ranges = new Map<string, { min: number; max: number }>();
  let result: Viewport3DChunkedScalarColorResult | null = null;
  function Probe() {
    result = useViewport3DChunkedScalarColors({
      buildDomainId: scope, buildSessionId: scope, colorModes: modes,
      colorPalette: palette, enabled: true, fieldRevision: scope,
      fieldScalarRangesByMode: ranges, fieldVector: field, topology,
      topologyRevision: "saved:geometry",
    });
    return null;
  }
  const current = () => result as Viewport3DChunkedScalarColorResult | null;
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  const root = createRoot(container as unknown as Element);
  async function settle(mode: string, maximum: number) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (current()?.status === "ready" && current()?.colors.get(mode)?.range.max === maximum) return;
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    }
    throw new Error("Saved field colors did not settle for the current request.");
  }
  try {
    await act(async () => root.render(<Probe />));
    await settle("x", count - 1);
    expect(current()?.colors.get("x")?.scalarValues).toHaveLength(count);
    expect(current()?.colors.get("x")?.colors).toHaveLength(0);

    modes = new Set(["y"]);
    palette = "inferno";
    ranges = new Map([["y", { min: 10, max: 20 }]]);
    await act(async () => root.render(<Probe />));
    await settle("y", 20);
    expect(current()?.colors.get("y")?.colorPalette).toBe("inferno");
    expect(current()?.colors.get("y")?.range).toEqual({ min: 10, max: 20 });
    expect(current()?.colors.has("x")).toBe(false);

    for (const [key, nodes, amplitude] of [
      ["saved:sparse-a", [0, 10_000, count - 1], 5],
      ["saved:sparse-b", [1, 20_000, count - 2], 9],
    ] as const) {
      scope = key;
      modes = new Set(["x"]);
      ranges = new Map();
      field = { ...field, grid: [3, 1, 1], indexing: "explicit_node_indices",
        nodeIndices: new Uint32Array(nodes), pointCount: 3, valueCount: 9,
        values: new Float64Array([-amplitude, 0, 0, 0, 0, 0, amplitude, 0, 0]) };
      await act(async () => root.render(<Probe />));
      await settle("x", amplitude);
      const colors = current()?.colors.get("x");
      expect(colors?.scalarValues).toHaveLength(count);
      expect(colors?.scalarValues?.[nodes[0]]).toBe(0);
      expect(colors?.scalarValues?.[nodes[2]]).toBe(1);
      expect(colors?.targetRevision).toBe(`topology=saved:geometry field=${key}`);
    }
  } finally {
    await act(async () => root.unmount());
    disposeViewport3DColorTransformWorker();
    dom.restore();
  }
});

it.each(["old-first", "old-last", "old-already-ready"] as const)(
  "fences an in-flight saved dataset when its delayed colors finish %s",
  async (completionOrder) => {
    const count = 50_004;
    const topology = buildViewport3DTopologyRenderModel({
      nodeCount: count, elementCount: 0, boundaryFaceCount: 0,
      positions: new Float64Array(count * 3), indices: new Uint32Array(),
      elementMarkers: new Uint32Array(), boundaryFaces: new Uint32Array(),
      boundaryMarkers: new Uint32Array(),
    }, [], [], new Map())!;
    function fieldFor(scopeId: string, amplitude: number): Viewport3DFieldVector {
      const values = new Float64Array(count * 3);
      for (let node = 0; node < count; node += 1) {
        values[node * 3] = node % 2 ? amplitude : -amplitude;
      }
      return {
        dtype: "float64", grid: [count, 1, 1], nComp: 3, pointCount: count,
        quantityId: "J_charge", scopeId, valueCount: values.length, values,
      };
    }
    const pending = new Map<string, { release: () => void; signal?: AbortSignal }>();
    const originalBuild = colorScheduler.buildVertexScalarColorsOffMainThread;
    const spy = vi.spyOn(colorScheduler, "buildVertexScalarColorsOffMainThread")
      .mockImplementation(async (field, options) => {
        const buffer = await originalBuild(field, options);
        await new Promise<void>(release => {
          pending.set(field.scopeId!, { release, signal: options?.signal });
        });
        return buffer;
      });
    let field = fieldFor("saved:delayed-a", 1);
    const modes = new Set(["x"]);
    let result: Viewport3DChunkedScalarColorResult | null = null;
    function Probe() {
      result = useViewport3DChunkedScalarColors({
        buildDomainId: field.scopeId ?? undefined, buildSessionId: field.scopeId ?? undefined,
        colorModes: modes, colorPalette: "viridis", enabled: true,
        fieldRevision: field.scopeId, fieldVector: field, topology,
        topologyRevision: "saved:shared-geometry",
      });
      return null;
    }
    const current = () => result as Viewport3DChunkedScalarColorResult | null;
    async function until(check: () => boolean, message: string) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (check()) return;
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
      }
      throw new Error(message);
    }
    const dom = installSimulationPreparationTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    try {
      await act(async () => root.render(<Probe />));
      await until(() => pending.has("saved:delayed-a"), "The first saved build did not start.");
      if (completionOrder === "old-already-ready") {
        await act(async () => pending.get("saved:delayed-a")!.release());
        await until(() => current()?.status === "ready", "The first saved dataset did not settle.");
        expect(current()?.colors.get("x")?.range).toEqual({ min: -1, max: 1 });
      }
      field = fieldFor("saved:current-b", 9);
      await act(async () => root.render(<Probe />));
      await until(() => pending.has("saved:current-b"), "The new saved dataset waited for the old build.");
      if (completionOrder !== "old-already-ready") {
        expect(pending.get("saved:delayed-a")?.signal?.aborted).toBe(true);
      }
      expect(current()?.colors.size).toBe(0);
      if (completionOrder === "old-first") {
        await act(async () => pending.get("saved:delayed-a")!.release());
        expect(current()?.colors.size).toBe(0);
        expect(current()?.status).toBe("building");
      }
      await act(async () => pending.get("saved:current-b")!.release());
      await until(() => current()?.status === "ready", "The new saved dataset did not settle.");
      const buffer = current()?.colors.get("x");
      expect(buffer?.range).toEqual({ min: -9, max: 9 });
      expect(buffer?.targetRevision).toBe("topology=saved:shared-geometry field=saved:current-b");
      if (completionOrder === "old-last") {
        await act(async () => pending.get("saved:delayed-a")!.release());
        expect(current()?.status).toBe("ready");
        expect(current()?.colors.get("x")).toBe(buffer);
      }
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => {
        root.unmount();
        for (const job of pending.values()) job.release();
      });
      spy.mockRestore();
      disposeViewport3DColorTransformWorker();
      dom.restore();
    }
  },
);
