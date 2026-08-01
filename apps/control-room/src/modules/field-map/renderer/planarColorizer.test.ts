import { describe, expect, it, vi } from "vitest";

import { createPlanarColorizer } from "./planarColorizer";

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

    colorizer.colorize(first, { max: 1, min: 0 });
    colorizer.colorize(second, { max: 1, min: 0 });
    worker.onmessage?.({
      data: { id: 1, kind: "colorized", pixels: new Uint8ClampedArray(4) },
    } as MessageEvent);
    worker.onmessage?.({
      data: { id: 2, kind: "colorized", pixels: new Uint8ClampedArray(8) },
    } as MessageEvent);

    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    expect(worker.postMessage.mock.calls[0]?.[1]).toEqual([first.buffer]);
    expect(onPixels).toHaveBeenCalledTimes(1);
    colorizer.dispose();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
