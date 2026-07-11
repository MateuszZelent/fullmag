import { afterEach, describe, expect, it, vi } from "vitest";

import { buildViewport3DVectorGlyphsOffMainThread, disposeVectorGlyphBuildWorker } from "./layers/vectorGlyphBuildScheduler";
import { buildViewport3DFdmCuboidOffMainThread, disposeViewport3DFdmCuboidBuildWorker } from "./layers/fdmCuboidBuildScheduler";
import { buildViewport3DRegionOverlaysOffMainThread, disposeViewport3DRegionOverlayBuildWorker } from "./region-overlays/viewport3dRegionOverlayBuildScheduler";
import { buildVertexScalarColorsOffMainThread, disposeViewport3DColorTransformWorker } from "./viewport3dColorTransformScheduler";
import { buildViewport3DTopologyIndicesOffMainThread, disposeViewport3DTopologyIndexWorker } from "./viewport3dTopologyIndexScheduler";

class PendingWorker {
  static instances: PendingWorker[] = [];
  readonly listeners = new Map<string, Set<EventListener>>();
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { PendingWorker.instances.push(this); }
  addEventListener(type: string, listener: EventListener): void { (this.listeners.get(type) ?? this.create(type)).add(listener); }
  removeEventListener(type: string, listener: EventListener): void { this.listeners.get(type)?.delete(listener); }
  private create(type: string): Set<EventListener> { const listeners = new Set<EventListener>(); this.listeners.set(type, listeners); return listeners; }
}

describe("viewport 3D production worker disposers", () => {
  afterEach(() => {
    disposeViewport3DTopologyIndexWorker(); disposeViewport3DColorTransformWorker(); disposeViewport3DRegionOverlayBuildWorker(); disposeVectorGlyphBuildWorker(); disposeViewport3DFdmCuboidBuildWorker();
    PendingWorker.instances = []; vi.unstubAllGlobals();
  });

  it("terminates every lane worker and rejects their pending jobs with AbortError", async () => {
    vi.stubGlobal("Worker", PendingWorker);
    const pending = [
      buildViewport3DTopologyIndicesOffMainThread({ airboxParts: [], magneticParts: [], topology: { boundaryFaces: new Uint32Array(), indices: new Uint32Array(), nodeCount: 0 } }, { buildKey: "runtime:topology" }),
      buildVertexScalarColorsOffMainThread({ dtype: "float64", grid: [1, 1, 1], nComp: 3, pointCount: 1, quantityId: "m", valueCount: 3, values: new Float64Array([1, 0, 0]) }, { buildKey: "runtime:color", colorMode: "orientation", colorPalette: "viridis", shaderOnly: true }),
      buildViewport3DRegionOverlaysOffMainThread({ magneticParts: [], regions: [], topology: { boundaryFaceCount: 0, boundaryFaces: new Uint32Array(), boundaryMarkers: new Uint32Array(), elementCount: 0, elementMarkers: new Uint32Array(), indices: new Uint32Array(), nodeCount: 0, positions: new Float64Array() } }, { buildKey: "runtime:region" }),
      buildViewport3DVectorGlyphsOffMainThread({ colorMode: "x", headRadiusRatio: 0.2, segments: new Float32Array([0, 0, 0, 1, 0, 0, 1]), shaftRadiusRatio: 0.1 }, { buildKey: "runtime:glyph" }),
      buildViewport3DFdmCuboidOffMainThread({ domain: null, maxVectorGlyphs: 1, vectorAnchorMode: "center", vectorScale: 1, voxelFillRatio: 0.9, voxelMagnitudeThreshold: 0, voxelTopography: { amplitudeCells: 0, component: "magnitude", enabled: false } }, { buildKey: "runtime:fdm" }),
    ].map((promise) => promise.catch((error: unknown) => error));
    expect(PendingWorker.instances).toHaveLength(5);
    disposeViewport3DTopologyIndexWorker(); disposeViewport3DColorTransformWorker(); disposeViewport3DRegionOverlayBuildWorker(); disposeVectorGlyphBuildWorker(); disposeViewport3DFdmCuboidBuildWorker();
    const results = await Promise.all(pending);
    expect(results.every((error) => error instanceof Error && error.name === "AbortError")).toBe(true);
    expect(PendingWorker.instances.every((worker) => worker.terminate.mock.calls.length === 1 && Array.from(worker.listeners.values()).every((listeners) => listeners.size === 0))).toBe(true);
  });
});
