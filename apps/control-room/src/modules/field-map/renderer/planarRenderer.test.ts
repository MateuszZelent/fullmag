import { describe, expect, it, vi } from "vitest";

import { createPlanarRenderer, drawPlanarOverlays, partitionPlanarMeshSegments } from "./planarRenderer";

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

  it("draws mesh and contours in one imperative layer", () => {
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
      gridWidth: 2,
      meshSegments: new Float32Array([0, 0, 1, 1]),
    });

    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 100, 50);
    expect(context.stroke).toHaveBeenCalledTimes(2);
    expect(context.restore).toHaveBeenCalledTimes(1);
  });

  it("draws arrowheads with a dark halo and reports the drawn glyph count", () => {
    const context = {
      arc: vi.fn(), beginPath: vi.fn(), clearRect: vi.fn(), closePath: vi.fn(), fill: vi.fn(),
      fillStyle: "", globalAlpha: 1, lineCap: "butt", lineJoin: "miter", lineTo: vi.fn(),
      lineWidth: 0, moveTo: vi.fn(), restore: vi.fn(), save: vi.fn(), stroke: vi.fn(), strokeStyle: "",
    } as unknown as CanvasRenderingContext2D;
    const values = new Float64Array(4 * 3);
    for (let index = 0; index < 4; index += 1) values.set([1, 0, 0], index * 3);

    const result = drawPlanarOverlays(context, 100, 100, {
      gridHeight: 2,
      gridWidth: 2,
      layers: { contours: false, mesh: false, vectors: true },
      meshViewport: [0, 1, 0, 1],
      vectorColorMode: "monochrome",
      vectorField: { budget: 4, lengthMode: "uniform", sampleBounds: [0, 1, 0, 1], scale: 1, values },
      vectorStyle: { color: "#0000ff", opacity: 1, thickness: 1 },
    });

    expect(result.glyphCount).toBe(4);
    // One halo pass and one colour pass per glyph, each with a filled head.
    expect(context.fill).toHaveBeenCalledTimes(8);
    expect(context.closePath).toHaveBeenCalledTimes(8);
  });

  it("draws streamlines in physical coordinates only when the layer is enabled", () => {
    const makeContext = () => ({
      arc: vi.fn(), beginPath: vi.fn(), clearRect: vi.fn(), closePath: vi.fn(), fill: vi.fn(),
      fillStyle: "", globalAlpha: 1, lineCap: "butt", lineJoin: "miter", lineTo: vi.fn(),
      lineWidth: 0, moveTo: vi.fn(), restore: vi.fn(), save: vi.fn(), stroke: vi.fn(), strokeStyle: "",
    }) as unknown as CanvasRenderingContext2D;
    const streamlines = {
      lineCount: 1,
      offsets: new Uint32Array([0, 3]),
      pointCount: 3,
      points: new Float64Array([0, 0.5, 0.5, 0.5, 1, 0.5]),
      separation: 0.25,
      truncated: false,
    };
    const enabled = makeContext();
    drawPlanarOverlays(enabled, 100, 100, {
      gridWidth: 2,
      layers: { contours: false, mesh: false, streamlines: true, vectors: false },
      meshViewport: [0, 1, 0, 1],
      streamlines,
      vectorColorMode: "contrast",
    });
    // Halo and line pass: each starts the polyline at u = 0 (x = 0, y = 50).
    expect(enabled.moveTo).toHaveBeenCalledWith(0, 50);
    expect(enabled.lineTo).toHaveBeenCalledWith(100, 50);
    expect(enabled.stroke).toHaveBeenCalledTimes(2);

    const disabled = makeContext();
    drawPlanarOverlays(disabled, 100, 100, {
      gridWidth: 2,
      layers: { contours: false, mesh: false, streamlines: false, vectors: false },
      meshViewport: [0, 1, 0, 1],
      streamlines,
    });
    expect(disabled.lineTo).not.toHaveBeenCalled();
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
      gridWidth: 2,
      layers: { contours: false, mesh: false, vectors: false },
      meshViewport: [0, 1, 0, 1],
      vectorField: { budget: 4, lengthMode: "uniform", sampleBounds: [0, 1, 0, 1], scale: 1, values: new Float64Array([1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]) },
      meshSegments: new Float32Array([0, 0, 1, 1]),
    });

    expect(context.stroke).not.toHaveBeenCalled();
    expect(context.moveTo).not.toHaveBeenCalled();
  });

  it("draws exact monitor bounds and occupied evaluation-bin centers as independent layers", () => {
    const context = {
      arc: vi.fn(), beginPath: vi.fn(), clearRect: vi.fn(), fill: vi.fn(), fillStyle: "",
      lineTo: vi.fn(), lineWidth: 0, moveTo: vi.fn(), restore: vi.fn(), save: vi.fn(),
      stroke: vi.fn(), strokeStyle: "",
    } as unknown as CanvasRenderingContext2D;

    drawPlanarOverlays(context, 100, 50, {
      boundsOutline: [2, 6, -4, 4],
      gridWidth: 4,
      layers: { bounds: true, contours: false, mesh: false, points: true, vectors: false },
      meshViewport: [2, 6, -4, 4],
      samplePoints: [
        { index: 0, u: 2.5, v: -2 },
        { index: 7, u: 5.5, v: 2 },
      ],
    });

    expect(context.moveTo).toHaveBeenCalledWith(0, 50);
    expect(context.lineTo).toHaveBeenCalledWith(100, 50);
    expect(context.lineTo).toHaveBeenCalledWith(100, 0);
    expect(context.arc).toHaveBeenCalledTimes(2);
    expect(context.fill).toHaveBeenCalledTimes(1);
  });

  it("applies shared Inspector wireframe and point styles", () => {
    const context = {
      arc: vi.fn(), beginPath: vi.fn(), clearRect: vi.fn(), fill: vi.fn(), fillStyle: "",
      globalAlpha: 1, lineTo: vi.fn(), lineWidth: 0, moveTo: vi.fn(), restore: vi.fn(),
      save: vi.fn(), stroke: vi.fn(), strokeStyle: "",
    } as unknown as CanvasRenderingContext2D;

    drawPlanarOverlays(context, 100, 50, {
      gridWidth: 2,
      layers: { contours: false, mesh: true, points: true, vectors: false },
      meshSegments: new Float32Array([0, 0, 1, 1]),
      meshViewport: [0, 1, 0, 1],
      pointStyle: { color: "#00ff00", opacity: 0.5, size: 8 },
      samplePoints: [{ index: 0, u: 0.5, v: 0.5 }],
      vectorColorMode: "monochrome",
      vectorStyle: { color: "#0000ff", opacity: 0.6, thickness: 3 },
      wireframeStyle: { color: "#ff0000", opacity: 0.4 },
    });

    expect(context.arc).toHaveBeenCalledWith(50, 25, 4, 0, Math.PI * 2);
    expect(context.stroke).toHaveBeenCalledTimes(1);
    expect(context.fill).toHaveBeenCalledTimes(1);
    expect(context.globalAlpha).toBe(1);
    expect(context.lineWidth).toBe(1);
  });

  it("draws an Amumax-style axis pointer in physical viewport coordinates", () => {
    const context = {
      beginPath: vi.fn(), clearRect: vi.fn(), lineTo: vi.fn(), lineWidth: 0,
      moveTo: vi.fn(), restore: vi.fn(), save: vi.fn(), setLineDash: vi.fn(),
      stroke: vi.fn(), strokeStyle: "",
    } as unknown as CanvasRenderingContext2D;

    drawPlanarOverlays(context, 200, 100, {
      axisPointer: { u: 3, v: 2 },
      gridWidth: 2,
      layers: { contours: false, mesh: false, vectors: false },
      meshViewport: [1, 5, 0, 4],
    } as Parameters<typeof drawPlanarOverlays>[3]);

    expect(context.setLineDash).toHaveBeenCalledWith([6, 4]);
    expect(context.moveTo).toHaveBeenCalledWith(100, 0);
    expect(context.lineTo).toHaveBeenCalledWith(100, 100);
    expect(context.moveTo).toHaveBeenCalledWith(0, 50);
    expect(context.lineTo).toHaveBeenCalledWith(200, 50);
  });

  it("resolves the accent token before painting the axis pointer", () => {
    const canvas = {
      ownerDocument: {
        defaultView: {
          getComputedStyle: vi.fn(() => ({
            getPropertyValue: vi.fn(() => "rgb(203, 166, 247)"),
          })),
        },
      },
    } as unknown as HTMLCanvasElement;
    const context = {
      beginPath: vi.fn(), clearRect: vi.fn(), lineTo: vi.fn(), lineWidth: 0,
      moveTo: vi.fn(), restore: vi.fn(), save: vi.fn(), setLineDash: vi.fn(),
      stroke: vi.fn(), strokeStyle: "",
      canvas,
    } as unknown as CanvasRenderingContext2D;

    drawPlanarOverlays(context, 200, 100, {
      axisPointer: { u: 3, v: 2 },
      gridWidth: 2,
      layers: { contours: false, mesh: false, vectors: false },
      meshViewport: [1, 5, 0, 4],
    } as Parameters<typeof drawPlanarOverlays>[3]);

    expect(context.strokeStyle).toBe("rgb(203, 166, 247)");
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
      const backing = new Uint8ClampedArray([99, 1, 2, 3, 4, 88]);
      renderer.draw(backing.subarray(1, 5), 1, 1);
      const ordinaryImage = context.putImageData.mock.calls.at(-1)?.[0];
      expect([...ordinaryImage.data]).toEqual([1, 2, 3, 4]);
      expect(ordinaryImage.data.buffer).toBe(backing.buffer);
      const shared = new Uint8ClampedArray(new SharedArrayBuffer(6));
      shared.set([99, 5, 6, 7, 8, 88]);
      renderer.draw(shared.subarray(1, 5), 1, 1);
      const sharedImage = context.putImageData.mock.calls.at(-1)?.[0];
      expect([...sharedImage.data]).toEqual([5, 6, 7, 8]);
      expect(sharedImage.data.buffer).toBeInstanceOf(ArrayBuffer);
      expect([...shared]).toEqual([99, 5, 6, 7, 8, 88]);
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

  it("clears and forgets the owned raster when the scalar layer is disabled", () => {
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
      const drawsBeforeClear = context.drawImage.mock.calls.length;
      const clearsBeforeClear = context.clearRect.mock.calls.length;

      renderer.clearBase();
      renderer.setViewport([0, 1, 0, 1], [0, 1, 0, 1]);

      expect(context.clearRect).toHaveBeenCalledTimes(clearsBeforeClear + 1);
      expect(context.drawImage).toHaveBeenCalledTimes(drawsBeforeClear);
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      if (originalImageData) Object.defineProperty(globalThis, "ImageData", originalImageData);
      else Reflect.deleteProperty(globalThis, "ImageData");
    }
  });

  it("maps backend row zero at v_min to the bottom consistently for raster contours", () => {
    const context = {
      beginPath: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(), imageSmoothingEnabled: true,
      lineTo: vi.fn(), lineWidth: 0, moveTo: vi.fn(), restore: vi.fn(), save: vi.fn(), stroke: vi.fn(), strokeStyle: "",
    } as unknown as CanvasRenderingContext2D;
    drawPlanarOverlays(context, 100, 100, {
      contours: [[0, 0, 1, 1]],
      gridHeight: 2,
      gridWidth: 2,
      layers: { contours: true, mesh: false, vectors: false },
    });
    expect(context.moveTo).toHaveBeenCalledWith(0, 100);
    expect(context.lineTo).toHaveBeenCalledWith(100, 0);
  });

  it("draws exact target boundaries independently from the mesh layer", () => {
    const partition = partitionPlanarMeshSegments({
      boundaryClassification: "exact",
      segmentKinds: new Uint8Array([0, 1, 2]),
      segments: new Float32Array([0, 0, 1, 0, 1, 0, 1, 1, 0, 1, 1, 1]),
    });
    expect(partition.boundarySegments).toEqual(new Float32Array([1, 0, 1, 1]));
    const context = {
      beginPath: vi.fn(), clearRect: vi.fn(), lineTo: vi.fn(), lineWidth: 0,
      moveTo: vi.fn(), restore: vi.fn(), save: vi.fn(), stroke: vi.fn(), strokeStyle: "",
    } as unknown as CanvasRenderingContext2D;
    drawPlanarOverlays(context, 100, 100, {
      boundarySegments: partition.boundarySegments,
      gridWidth: 1,
      layers: { boundaries: true, contours: false, mesh: false, vectors: false },
      meshViewport: [0, 1, 0, 1],
    });
    expect(context.stroke).toHaveBeenCalledTimes(1);
    expect(context.moveTo).toHaveBeenCalledWith(100, 100);
  });

  it("flips the backend v_min row by canvas transform rather than a negative drawImage height", () => {
    const callOrder: string[] = [];
    const context = {
      clearRect: vi.fn(), drawImage: vi.fn(() => callOrder.push("drawImage")), imageSmoothingEnabled: true,
      restore: vi.fn(), save: vi.fn(() => callOrder.push("save")), scale: vi.fn(() => callOrder.push("scale")), translate: vi.fn(() => callOrder.push("translate")),
    } as unknown as CanvasRenderingContext2D;
    const scratchContext = { putImageData: vi.fn() } as unknown as CanvasRenderingContext2D;
    const canvas = { getContext: vi.fn(() => context), height: 100, width: 100 } as unknown as HTMLCanvasElement;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    const imageData = Object.getOwnPropertyDescriptor(globalThis, "ImageData");
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => ({ getContext: () => scratchContext, height: 0, width: 0 }) } });
    Object.defineProperty(globalThis, "ImageData", { configurable: true, value: class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} } });
    try {
      const renderer = createPlanarRenderer(canvas);
      renderer.setViewport([0, 1, 0, 1], [0, 1, 0, 1]);
      renderer.draw(new Uint8ClampedArray(8), 1, 2);
      expect(context.translate).toHaveBeenCalledWith(0, 100);
      expect(context.scale).toHaveBeenCalledWith(1, -1);
      expect(context.drawImage).toHaveBeenLastCalledWith(expect.anything(), 0, 0, 1, 2, 0, 0, 100, 100);
      expect(callOrder.slice(-4)).toEqual(["save", "translate", "scale", "drawImage"]);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "document", descriptor); else Reflect.deleteProperty(globalThis, "document");
      if (imageData) Object.defineProperty(globalThis, "ImageData", imageData); else Reflect.deleteProperty(globalThis, "ImageData");
    }
  });
});
