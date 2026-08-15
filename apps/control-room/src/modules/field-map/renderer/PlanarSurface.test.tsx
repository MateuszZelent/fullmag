import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import {
  findElement,
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { PLANAR_OCCUPANCY } from "../model/planarOccupancy";
import { resolvePlanarEvidenceStatus } from "../model/fieldMapEvidence";
import { buildFieldMapRenderModel } from "../model/fieldMapRenderModel";
import type {
  PlanarColorizeRequest,
  PlanarColorizeResponse,
} from "./planarRendererProtocol";
import { colorizePlanarRendererRequest } from "./planarRendererTask";
import { PlanarSurface } from "./PlanarSurface";

function makeRenderModel(
  values: readonly number[],
  bounds: readonly [number, number, number, number],
  mask?: Uint8Array,
) {
  return buildFieldMapRenderModel({
    bounds,
    canonicalUnit: "m",
    component: "magnitude",
    frame: {
      normal: [0, 0, 1],
      uAxis: [1, 0, 0],
      vAxis: [0, 1, 0],
    },
    layers: { contours: true, mesh: false, raster: true, vectors: false },
    mask,
    range: { mode: "auto" },
    resolution: [values.length, 1],
    sampleIdentity: '"fm-planar-sha256:current"',
    scalar: new Float64Array(values),
  });
}

describe("PlanarSurface lifecycle", () => {
  it("preserves an empty occupancy pixel through worker colorization and hover, then releases owned rendering resources", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const putImageData = vi.fn();
    const drawImage = vi.fn();
    const canvasContext = {
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      drawImage,
      imageSmoothingEnabled: true,
      lineTo: vi.fn(),
      lineWidth: 0,
      moveTo: vi.fn(),
      putImageData,
      restore: vi.fn(),
      save: vi.fn(),
      scale: vi.fn(),
      stroke: vi.fn(),
      strokeStyle: "",
      translate: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    const originalCreateElement = dom.document.createElement.bind(dom.document);
    dom.document.createElement = ((tagName: string) => {
      const element = originalCreateElement(tagName);
      if (tagName.toLowerCase() === "canvas") {
        Object.assign(element, {
          getContext: vi.fn(() => canvasContext),
          height: 0,
          width: 0,
        });
      }
      return element;
    }) as typeof dom.document.createElement;

    const observers: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
    class TestResizeObserver {
      readonly disconnect = vi.fn();

      constructor(
        private readonly callback: ResizeObserverCallback,
      ) {
        observers.push(this);
      }

      observe(target: Element): void {
        this.callback(
          [{ contentRect: { height: 100, width: 200 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
        Object.assign(target, { clientHeight: 100, clientWidth: 200 });
      }

      unobserve(): void {}
    }

    const workers: TestWorker[] = [];
    const workerTransfers: Array<{
      after: readonly number[];
      before: readonly number[];
    }> = [];
    class TestWorker {
      onmessage: ((event: MessageEvent<PlanarColorizeResponse>) => void) | null = null;
      readonly terminate = vi.fn();

      constructor() {
        workers.push(this);
      }

      postMessage(
        request: PlanarColorizeRequest,
        transfer: Transferable[],
      ): void {
        const before = transfer.map((item) => (item as ArrayBuffer).byteLength);
        const workerRequest = structuredClone(request, { transfer });
        workerTransfers.push({
          after: transfer.map((item) => (item as ArrayBuffer).byteLength),
          before,
        });
        queueMicrotask(() => {
          this.onmessage?.({
            data: colorizePlanarRendererRequest(workerRequest),
          } as MessageEvent<PlanarColorizeResponse>);
        });
      }
    }

    const previousImageData = Object.getOwnPropertyDescriptor(globalThis, "ImageData");
    const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    Object.defineProperty(globalThis, "ImageData", {
      configurable: true,
      value: class TestImageData {
        constructor(
          readonly data: Uint8ClampedArray,
          readonly width: number,
          readonly height: number,
        ) {}
      },
    });
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: TestResizeObserver,
    });
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: TestWorker,
    });

    const mask = new Uint8Array([
      PLANAR_OCCUPANCY.empty,
      PLANAR_OCCUPANCY.occupied,
    ]).buffer;
    const onPin = vi.fn();
    const onRenderEvidence = vi.fn();
    const initialModel = makeRenderModel(
      [10, 20],
      [2, 6, -4, 4],
      new Uint8Array(mask),
    );
    let scalarCanvas: TestElement | null = null;
    try {
      await act(async () => {
        root.render(
          <PlanarSurface
            model={initialModel}
            onPin={onPin}
            onRenderEvidence={onRenderEvidence}
          />,
        );
      });

      scalarCanvas = findElement(
        container,
        (element) => element.getAttribute("aria-label") === "Planar scalar field",
        "planar scalar canvas",
      );
      Object.assign(scalarCanvas, { clientHeight: 100, clientWidth: 200 });

      const raster = putImageData.mock.calls[0]?.[0] as { data: Uint8ClampedArray };
      expect(workerTransfers).toEqual([{
        after: [0, 0],
        before: [16, 2],
      }]);
      expect(initialModel.scalar.byteLength).toBe(16);
      expect(Array.from(initialModel.scalar)).toEqual([10, 20]);
      expect(mask.byteLength).toBe(2);
      expect(Array.from(raster.data.slice(0, 4))).toEqual([0, 0, 0, 0]);
      expect(raster.data[7]).toBe(255);
      expect(onRenderEvidence).toHaveBeenLastCalledWith({
        glyphCount: 0,
        overlayCounts: { boundsSegments: 0, contours: 0, meshSegments: 0, pointMarkers: 0 },
        raster: {
          checksum: "fnv1a32:4c4ff03b",
          max: 20,
          min: 20,
          sampleCount: 2,
        },
        sampleIdentity: "\"fm-planar-sha256:current\"",
      });
      const renderedEvidence = onRenderEvidence.mock.lastCall?.[0];
      expect(
        resolvePlanarEvidenceStatus({
          metaIdentity: '"fm-planar-sha256:new"',
          metaStatus: "ready",
          renderEvidence: renderedEvidence,
          scalarIdentity: '"fm-planar-sha256:current"',
          scalarStatus: "loading",
        }),
      ).toBe("loading");
      expect(
        resolvePlanarEvidenceStatus({
          metaIdentity: '"fm-planar-sha256:current"',
          metaStatus: "ready",
          renderEvidence: renderedEvidence,
          scalarIdentity: '"fm-planar-sha256:stale"',
          scalarStatus: "ready",
        }),
      ).toBe("loading");

      const occupiedPointerMove = new TestEvent("pointermove", { bubbles: true });
      Object.assign(occupiedPointerMove, { clientX: 150, clientY: 50 });
      await act(async () => {
        scalarCanvas?.dispatchEvent(occupiedPointerMove);
      });
      const probeOutput = findElement(
        container,
        (element) => element.tagName === "OUTPUT",
        "probe output",
      );
      expect(probeOutput.textContent).toBe("20 m");

      const emptyPointerMove = new TestEvent("pointermove", { bubbles: true });
      Object.assign(emptyPointerMove, { clientX: 25, clientY: 50 });
      await act(async () => {
        scalarCanvas?.dispatchEvent(emptyPointerMove);
      });
      expect(
        probeOutput.textContent,
      ).toBe("No sample");

      const pin = new TestEvent("keydown", { bubbles: true, key: "Enter" });
      await act(async () => {
        scalarCanvas?.dispatchEvent(pin);
      });
      expect(onPin).toHaveBeenCalledWith(4, 0);

      await act(async () => {
        root.render(<PlanarSurface model={{
          ...initialModel,
          interaction: { panU: 0, panV: 0, zoom: 2 },
          viewport: [3, 5, -2, 2],
        }} onPin={onPin} onRenderEvidence={onRenderEvidence} />);
      });
      expect(workers).toHaveLength(1);
      expect(workers[0]?.terminate).not.toHaveBeenCalled();
      expect(workerTransfers).toHaveLength(1);
      expect(observers).toHaveLength(1);
      expect(observers[0]?.disconnect).not.toHaveBeenCalled();

      await act(async () => root.unmount());
      expect(workers).toHaveLength(1);
      expect(workers[0]?.terminate).toHaveBeenCalledTimes(1);
      expect(observers).toHaveLength(1);
      expect(observers[0]?.disconnect).toHaveBeenCalledTimes(1);
      expect((scalarCanvas as unknown as { width: number }).width).toBe(0);
    } finally {
      await act(async () => root.unmount());
      if (previousImageData) {
        Object.defineProperty(globalThis, "ImageData", previousImageData);
      } else {
        Reflect.deleteProperty(globalThis, "ImageData");
      }
      if (previousWorker) {
        Object.defineProperty(globalThis, "Worker", previousWorker);
      } else {
        Reflect.deleteProperty(globalThis, "Worker");
      }
      dom.restore();
    }
  });

  it("formats hover values in the display unit without mutating the canonical sample", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const context = {
      beginPath: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(), imageSmoothingEnabled: true,
      lineTo: vi.fn(), lineWidth: 0, moveTo: vi.fn(), putImageData: vi.fn(), restore: vi.fn(), save: vi.fn(), scale: vi.fn(), stroke: vi.fn(), strokeStyle: "", translate: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    const originalCreateElement = dom.document.createElement.bind(dom.document);
    dom.document.createElement = ((tagName: string) => {
      const element = originalCreateElement(tagName);
      if (tagName.toLowerCase() === "canvas") Object.assign(element, { getContext: vi.fn(() => context), height: 0, width: 0 });
      return element;
    }) as typeof dom.document.createElement;
    class TestResizeObserver { constructor(private readonly callback: ResizeObserverCallback) {} observe(target: Element): void { this.callback([{ contentRect: { height: 100, width: 100 } } as ResizeObserverEntry], this as unknown as ResizeObserver); Object.assign(target, { clientHeight: 100, clientWidth: 100 }); } disconnect(): void {} unobserve(): void {} }
    class TestWorker { onmessage: ((event: MessageEvent<PlanarColorizeResponse>) => void) | null = null; postMessage(request: PlanarColorizeRequest): void { queueMicrotask(() => this.onmessage?.({ data: colorizePlanarRendererRequest(request) } as MessageEvent<PlanarColorizeResponse>)); } terminate(): void {} }
    const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    const previousImageData = Object.getOwnPropertyDescriptor(globalThis, "ImageData");
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: TestWorker });
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: TestResizeObserver });
    Object.defineProperty(globalThis, "ImageData", { configurable: true, value: class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} } });
    const model = buildFieldMapRenderModel({
      bounds: [0, 1, 0, 1], canonicalUnit: "A/m", component: "normal", displayUnit: "kA/m",
      frame: { normal: [0, 0, 1], uAxis: [1, 0, 0], vAxis: [0, 1, 0] },
      layers: { contours: false, mesh: false, raster: true, vectors: false }, range: { mode: "auto" },
      resolution: [1, 1], sampleIdentity: '"fm-planar-sha256:unit"', scalar: new Float64Array([1_000]),
    });
    const onInteraction = vi.fn();
    try {
      await act(async () => { root.render(<PlanarSurface model={model} onInteraction={onInteraction} />); await Promise.resolve(); });
      const canvas = findElement(container, (element) => element.getAttribute("aria-label") === "Planar scalar field", "unit canvas");
      Object.assign(canvas, { clientHeight: 100, clientWidth: 100 });
      const move = new TestEvent("pointermove", { bubbles: true });
      Object.assign(move, { clientX: 50, clientY: 50 });
      await act(async () => { canvas.dispatchEvent(move); });
      const probe = findElement(container, (element) => element.tagName === "OUTPUT", "unit probe");
      expect(probe.textContent).toBe("1 kA/m");
      await act(async () => { canvas.dispatchEvent(new TestEvent("keydown", { bubbles: true, key: "+" })); });
      expect(onInteraction).toHaveBeenLastCalledWith({ panU: 0, panV: 0, zoom: 1.25 });
      expect(model.scalar[0]).toBe(1_000);
    } finally {
      await act(async () => root.unmount());
      if (previousWorker) Object.defineProperty(globalThis, "Worker", previousWorker); else Reflect.deleteProperty(globalThis, "Worker");
      if (previousImageData) Object.defineProperty(globalThis, "ImageData", previousImageData); else Reflect.deleteProperty(globalThis, "ImageData");
      dom.restore();
    }
  });

  it("does no colorizer work and disables pinning when scalar layers and probes are off", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const context = {
      beginPath: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(), imageSmoothingEnabled: true,
      lineTo: vi.fn(), lineWidth: 0, moveTo: vi.fn(), restore: vi.fn(), save: vi.fn(), scale: vi.fn(), stroke: vi.fn(), strokeStyle: "", translate: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    const originalCreateElement = dom.document.createElement.bind(dom.document);
    dom.document.createElement = ((tagName: string) => {
      const element = originalCreateElement(tagName);
      if (tagName.toLowerCase() === "canvas") Object.assign(element, { getContext: vi.fn(() => context), height: 0, width: 0 });
      return element;
    }) as typeof dom.document.createElement;
    const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: class { constructor() { throw new Error("worker must not start"); } } });
    const onPin = vi.fn();
    const onRenderEvidence = vi.fn();
    const model = buildFieldMapRenderModel({
      bounds: [0, 1, 0, 1], canonicalUnit: "A/m", component: "normal",
      frame: { normal: [0, 0, 1], uAxis: [1, 0, 0], vAxis: [0, 1, 0] },
      layers: { boundaries: false, contours: false, mesh: false, probes: false, raster: false, vectors: false },
      range: { mode: "auto" }, resolution: [1, 1], sampleIdentity: "no-scalar-layers", scalar: new Float64Array([1]),
    });
    try {
      await act(async () => { root.render(<PlanarSurface model={model} onPin={onPin} onRenderEvidence={onRenderEvidence} />); });
      const canvas = findElement(container, (element) => element.getAttribute("aria-label") === "Planar scalar field", "disabled probe canvas");
      const move = new TestEvent("pointermove", { bubbles: true });
      Object.assign(move, { clientX: 50, clientY: 50 });
      await act(async () => { canvas.dispatchEvent(move); canvas.dispatchEvent(new TestEvent("click", { bubbles: true })); });
      expect(onPin).not.toHaveBeenCalled();
      expect(onRenderEvidence).not.toHaveBeenCalled();
      expect(canvas.getAttribute("data-probes-enabled")).toBe("false");
      expect(canvas.getAttribute("tabindex")).toBe("-1");
    } finally {
      await act(async () => root.unmount());
      if (previousWorker) Object.defineProperty(globalThis, "Worker", previousWorker); else Reflect.deleteProperty(globalThis, "Worker");
      dom.restore();
    }
  });

  it("emits positive FMFG mesh evidence without starting a raster worker", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const context = {
      beginPath: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(), imageSmoothingEnabled: true,
      lineTo: vi.fn(), lineWidth: 0, moveTo: vi.fn(), restore: vi.fn(), save: vi.fn(), scale: vi.fn(), stroke: vi.fn(), strokeStyle: "", translate: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    const originalCreateElement = dom.document.createElement.bind(dom.document);
    dom.document.createElement = ((tagName: string) => {
      const element = originalCreateElement(tagName);
      if (tagName.toLowerCase() === "canvas") Object.assign(element, { getContext: vi.fn(() => context), height: 0, width: 0 });
      return element;
    }) as typeof dom.document.createElement;
    const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: class { constructor() { throw new Error("worker must not start"); } } });
    const onRenderEvidence = vi.fn();
    const overlay = new ArrayBuffer(176);
    const view = new DataView(overlay);
    [..."FMFG"].forEach((value, index) => view.setUint8(index, value.charCodeAt(0)));
    view.setUint32(4, 1, true); view.setUint32(8, 1, true);
    [0, 1, 0, 1].forEach((value, index) => view.setFloat64(32 + index * 8, value, true));
    [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((value, index) => view.setFloat64(64 + index * 8, value, true));
    [0, 0, 1, 0].forEach((value, index) => view.setFloat32(160 + index * 4, value, true));
    const model = buildFieldMapRenderModel({
      bounds: [0, 1, 0, 1], canonicalUnit: "A/m", component: "normal",
      frame: { normal: [0, 0, 1], uAxis: [1, 0, 0], vAxis: [0, 1, 0] },
      layers: { boundaries: false, contours: false, mesh: true, probes: false, raster: false, vectors: false },
      meshOverlay: overlay,
      meshOverlayDescriptor: { available: true, boundaryClassification: "unavailable", codec: "fmfg.v1", geometrySource: "fdm_structured_grid" },
      range: { mode: "auto" }, resolution: [1, 1], sampleIdentity: "fmfg-only", scalar: new Float64Array([1]),
    });
    try {
      await act(async () => { root.render(<PlanarSurface model={model} onRenderEvidence={onRenderEvidence} />); });
      expect(onRenderEvidence).toHaveBeenLastCalledWith(expect.objectContaining({
        overlayCounts: expect.objectContaining({ meshSegments: 1 }),
        raster: null,
        sampleIdentity: "fmfg-only",
      }));
    } finally {
      await act(async () => root.unmount());
      if (previousWorker) Object.defineProperty(globalThis, "Worker", previousWorker); else Reflect.deleteProperty(globalThis, "Worker");
      dom.restore();
    }
  });

  it("clears released raster state, cancels probes, and lazily recreates a contour-only worker", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const context = {
      beginPath: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(), imageSmoothingEnabled: true,
      lineTo: vi.fn(), lineWidth: 0, moveTo: vi.fn(), putImageData: vi.fn(), restore: vi.fn(), save: vi.fn(), scale: vi.fn(), stroke: vi.fn(), strokeStyle: "", translate: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    const originalCreateElement = dom.document.createElement.bind(dom.document);
    dom.document.createElement = ((tagName: string) => {
      const element = originalCreateElement(tagName);
      if (tagName.toLowerCase() === "canvas") Object.assign(element, { getContext: vi.fn(() => context), height: 0, width: 0 });
      return element;
    }) as typeof dom.document.createElement;
    class TestResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element): void {
        this.callback([{ contentRect: { height: 100, width: 100 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
        Object.assign(target, { clientHeight: 100, clientWidth: 100 });
      }
      disconnect(): void {}
      unobserve(): void {}
    }
    const workers: TestWorker[] = [];
    const requests: PlanarColorizeRequest[] = [];
    class TestWorker {
      onmessage: ((event: MessageEvent<PlanarColorizeResponse>) => void) | null = null;
      readonly terminate = vi.fn();

      constructor() {
        workers.push(this);
      }

      postMessage(request: PlanarColorizeRequest): void {
        requests.push(request);
        queueMicrotask(() => this.onmessage?.({ data: colorizePlanarRendererRequest(request) } as MessageEvent<PlanarColorizeResponse>));
      }
    }
    const frames: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancelAnimationFrame = vi.fn();
    const previousImageData = Object.getOwnPropertyDescriptor(globalThis, "ImageData");
    const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    const previousRequestAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
    const previousCancelAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
    Object.defineProperty(globalThis, "ImageData", { configurable: true, value: class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} } });
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: TestResizeObserver });
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: TestWorker });
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: requestAnimationFrame });
    Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: cancelAnimationFrame });
    const onRenderEvidence = vi.fn();
    const initialModel = makeRenderModel([1, 2], [0, 1, 0, 1]);
    try {
      await act(async () => {
        root.render(<PlanarSurface model={initialModel} onRenderEvidence={onRenderEvidence} />);
        await Promise.resolve();
      });
      const canvas = findElement(container, (element) => element.getAttribute("aria-label") === "Planar scalar field", "transition canvas");
      Object.assign(canvas, { clientHeight: 100, clientWidth: 100 });
      const pointerMove = new TestEvent("pointermove", { bubbles: true });
      Object.assign(pointerMove, { clientX: 75, clientY: 50 });
      await act(async () => { canvas.dispatchEvent(pointerMove); frames[0]?.(0); });
      const probe = findElement(container, (element) => element.tagName === "OUTPUT", "transition probe");
      expect(probe.textContent).toBe("2 m");
      await act(async () => { canvas.dispatchEvent(pointerMove); });
      const drawsBeforeRelease = (context.drawImage as ReturnType<typeof vi.fn>).mock.calls.length;
      const evidenceBeforeRelease = onRenderEvidence.mock.calls.length;

      await act(async () => {
        root.render(<PlanarSurface model={{
          ...initialModel,
          layers: { ...initialModel.layers, contours: false, probes: false, raster: false },
        }} onRenderEvidence={onRenderEvidence} />);
      });

      expect(cancelAnimationFrame).toHaveBeenCalledWith(2);
      expect(probe.textContent).toBe("No sample");
      expect(workers).toHaveLength(1);
      expect(workers[0]?.terminate).toHaveBeenCalledTimes(1);
      expect((context.drawImage as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(drawsBeforeRelease);
      expect(onRenderEvidence.mock.calls).toHaveLength(evidenceBeforeRelease);

      await act(async () => {
        root.render(<PlanarSurface model={{
          ...initialModel,
          layers: { ...initialModel.layers, contours: true, probes: true, raster: false },
        }} onRenderEvidence={onRenderEvidence} />);
        await Promise.resolve();
      });

      expect(probe.textContent).toBe("No sample");
      expect(workers).toHaveLength(2);
      expect(workers[1]?.terminate).not.toHaveBeenCalled();
      expect(requests).toHaveLength(2);
      expect(requests[1]?.contours).toMatchObject({ enabled: true });
      expect((context.drawImage as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(drawsBeforeRelease);
      expect(onRenderEvidence.mock.calls).toHaveLength(evidenceBeforeRelease);

      await act(async () => root.unmount());
      expect(workers[1]?.terminate).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      if (previousImageData) Object.defineProperty(globalThis, "ImageData", previousImageData); else Reflect.deleteProperty(globalThis, "ImageData");
      if (previousWorker) Object.defineProperty(globalThis, "Worker", previousWorker); else Reflect.deleteProperty(globalThis, "Worker");
      if (previousRequestAnimationFrame) Object.defineProperty(globalThis, "requestAnimationFrame", previousRequestAnimationFrame); else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      if (previousCancelAnimationFrame) Object.defineProperty(globalThis, "cancelAnimationFrame", previousCancelAnimationFrame); else Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
      dom.restore();
    }
  });
});
