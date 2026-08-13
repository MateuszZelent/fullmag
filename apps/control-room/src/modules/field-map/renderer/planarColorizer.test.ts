import { describe, expect, it, vi } from "vitest";

import { clonePlanarMaskForWorker, createPlanarColorizer } from "./planarColorizer";
import { colorizePlanarRendererRequest } from "./planarRendererTask";

describe("planar worker colorizer", () => {
  it("transfers typed arrays, ignores stale replies, and terminates", () => {
    const worker = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: vi.fn(),
      terminate: vi.fn(),
    };
    const onPixels = vi.fn();
    const colorizer = createPlanarColorizer(worker, onPixels);
    const first = new Float32Array([0]);
    const second = new Float32Array([1]);

    colorizer.colorize(first, { max: 1, min: 0 }, undefined, { colormap: "viridis", contours: false, height: 1, level: 0, opacity: 1, width: 1 });
    colorizer.colorize(second, { max: 1, min: 0 }, undefined, { colormap: "viridis", contours: false, height: 1, level: 0, opacity: 1, width: 1 });
    worker.onmessage?.({
      data: { id: 1, kind: "colorized", pixels: new Uint8ClampedArray(4) },
    } as MessageEvent);
    worker.onmessage?.({
      data: { id: 2, kind: "colorized", pixels: new Uint8ClampedArray(8) },
    } as MessageEvent);

    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    expect(worker.postMessage.mock.calls[0]?.[1]?.[0]).not.toBe(first.buffer);
    expect(first.byteLength).toBe(Float32Array.BYTES_PER_ELEMENT);
    expect(onPixels).toHaveBeenCalledTimes(1);
    colorizer.dispose();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("keeps the caller's occupancy mask attached while transferring a worker copy", () => {
    const worker = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: vi.fn(),
      terminate: vi.fn(),
    };
    const colorizer = createPlanarColorizer(worker, vi.fn());
    const values = new Float32Array([1]);
    const mask = new Uint8Array([0]);

    colorizer.colorize(values, { max: 1, min: 0 }, mask, { colormap: "viridis", contours: false, height: 1, level: 0, opacity: 1, width: 1 });

    const transferredMask = worker.postMessage.mock.calls[0]?.[0]?.mask as Uint8Array;
    expect(mask).toEqual(new Uint8Array([0]));
    expect(transferredMask).not.toBe(mask);
    expect(transferredMask).toEqual(mask);
    expect(clonePlanarMaskForWorker(mask)).not.toBe(mask);
  });

  it("returns contour geometry from the same transferred worker request as the raster", () => {
    const response = colorizePlanarRendererRequest({
      id: 1,
      kind: "colorize",
      range: { max: 3, min: 0 },
      values: new Float64Array([0, 1, 2, 3]),
      width: 2,
      height: 2,
      contours: { enabled: true, level: 1.5 },
    });

    expect(response.contours).toHaveLength(1);
  });
});
