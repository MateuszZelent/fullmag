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
import type {
  PlanarColorizeRequest,
  PlanarColorizeResponse,
} from "./planarRendererProtocol";
import { colorizePlanarRendererRequest } from "./planarRendererTask";
import { PlanarSurface } from "./PlanarSurface";

function makeScalarBuffer(values: readonly number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(
    48 + values.length * Float64Array.BYTES_PER_ELEMENT,
  );
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMVP"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint8(4, 2);
  view.setUint8(5, 1);
  view.setUint8(6, 1);
  view.setUint32(12, values.length, true);
  view.setUint32(16, values.length, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, 1, true);
  new TextEncoder().encodeInto("m", new Uint8Array(buffer, 28, 16));
  new Float64Array(buffer, 48).set(values);
  return buffer;
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
      stroke: vi.fn(),
      strokeStyle: "",
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
    let scalarCanvas: TestElement | null = null;
    try {
      await act(async () => {
        root.render(
          <PlanarSurface
            bounds={[0, 2, 0, 1]}
            frame={{
              normal: [0, 0, 1],
              uAxis: [1, 0, 0],
              vAxis: [0, 1, 0],
            }}
            height={1}
            mask={mask}
            scalar={makeScalarBuffer([10, 20])}
            width={2}
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
      expect(mask.byteLength).toBe(2);
      expect(Array.from(raster.data.slice(0, 4))).toEqual([0, 0, 0, 0]);
      expect(raster.data[7]).toBe(255);

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
      expect(probeOutput.textContent).toBe("20");

      const emptyPointerMove = new TestEvent("pointermove", { bubbles: true });
      Object.assign(emptyPointerMove, { clientX: 25, clientY: 50 });
      await act(async () => {
        scalarCanvas?.dispatchEvent(emptyPointerMove);
      });
      expect(
        probeOutput.textContent,
      ).toBe("No sample");

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
});
