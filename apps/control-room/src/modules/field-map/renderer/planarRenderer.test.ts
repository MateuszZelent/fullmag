import { describe, expect, it, vi } from "vitest";

import { createPlanarRenderer, drawPlanarOverlays } from "./planarRenderer";

describe("planar renderer lifecycle", () => {
  it("resizes with a bounded DPR and releases its canvas", () => {
    const context = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      imageSmoothingEnabled: true,
    };
    const canvas = {
      getContext: vi.fn(() => context),
      height: 0,
      width: 0,
    } as unknown as HTMLCanvasElement;
    const renderer = createPlanarRenderer(canvas);

    renderer.resize(100, 50, 3);
    expect([canvas.width, canvas.height]).toEqual([200, 100]);
    renderer.dispose();
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
    expect(context.clearRect).toHaveBeenCalled();
  });

  it("draws mesh, contours, and bounded vectors in one imperative layer", () => {
    const context = {
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      lineTo: vi.fn(),
      lineWidth: 0,
      moveTo: vi.fn(),
      restore: vi.fn(),
      save: vi.fn(),
      stroke: vi.fn(),
      strokeStyle: "",
    } as unknown as CanvasRenderingContext2D;

    drawPlanarOverlays(context, 100, 50, {
      contours: [[0, 1, 2, 3]],
      glyphs: [{ index: 3, normal: 1, u: 2, v: 0 }],
      gridWidth: 2,
      meshSegments: new Float32Array([0, 0, 1, 1]),
    });

    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 100, 50);
    expect(context.stroke).toHaveBeenCalledTimes(3);
    expect(context.restore).toHaveBeenCalledTimes(1);
  });
});
