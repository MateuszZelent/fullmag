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
    expect([canvas.width, canvas.height]).toEqual([300, 150]);
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

  it("draws only explicitly enabled overlay layers", () => {
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
      contours: [[0, 0, 1, 1]],
      glyphs: [{ index: 0, normal: 1, u: 0.4, v: 0 }],
      gridWidth: 2,
      layers: { contours: false, mesh: false, vectors: false },
      meshSegments: new Float32Array([0, 0, 1, 1]),
    });

    expect(context.stroke).not.toHaveBeenCalled();
    expect(context.moveTo).not.toHaveBeenCalled();
  });

  it("maps fit, pan, and zoom in CSS pixels while the backing canvas remains DPR-scaled", () => {
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
    const renderer = createPlanarRenderer(canvas) as unknown as {
      dispose(): void;
      resize(width: number, height: number, dpr: number): void;
      resolveViewport(bounds: readonly [number, number, number, number], interaction: { panU: number; panV: number; zoom: number }): readonly [number, number, number, number];
    };

    renderer.resize(200, 100, 2);
    expect(renderer.resolveViewport([0, 4, 0, 2], { panU: 1, panV: -0.5, zoom: 2 })).toEqual([
      2,
      4,
      0,
      1,
    ]);
    expect([canvas.width, canvas.height]).toEqual([400, 200]);
  });

  it("repaints the owned raster after DPR resize instead of requiring a new sample", () => {
    const context = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      imageSmoothingEnabled: true,
      putImageData: vi.fn(),
    };
    const canvas = {
      getContext: vi.fn(() => context),
      height: 0,
      width: 0,
    } as unknown as HTMLCanvasElement;
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalImageData = Object.getOwnPropertyDescriptor(globalThis, "ImageData");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement: vi.fn(() => ({ getContext: vi.fn(() => context), height: 0, width: 0 })) },
    });
    Object.defineProperty(globalThis, "ImageData", {
      configurable: true,
      value: class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} },
    });
    const renderer = createPlanarRenderer(canvas);

    try {
      renderer.resize(10, 10, 1);
      renderer.draw(new Uint8ClampedArray(4), 1, 1);
      const beforeResize = context.drawImage.mock.calls.length;
      renderer.resize(10, 10, 2);

      expect(context.drawImage).toHaveBeenCalledTimes(beforeResize + 1);
      expect([canvas.width, canvas.height]).toEqual([20, 20]);
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      if (originalImageData) Object.defineProperty(globalThis, "ImageData", originalImageData);
      else Reflect.deleteProperty(globalThis, "ImageData");
    }
  });

  it("maps backend row zero at v_min to the bottom consistently for raster contours glyphs and probe", () => {
    const context = {
      beginPath: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(), imageSmoothingEnabled: true,
      lineTo: vi.fn(), lineWidth: 0, moveTo: vi.fn(), restore: vi.fn(), save: vi.fn(), stroke: vi.fn(), strokeStyle: "",
    } as unknown as CanvasRenderingContext2D;
    drawPlanarOverlays(context, 100, 100, {
      contours: [[0, 0, 1, 1]],
      glyphs: [{ index: 0, normal: 0, u: 0, v: 0.1 }],
      gridHeight: 2,
      gridWidth: 2,
      layers: { contours: true, mesh: false, vectors: true },
    });
    expect(context.moveTo).toHaveBeenCalledWith(0, 100);
    expect(context.moveTo).toHaveBeenCalledWith(25, 75);
  });
});
