import { afterEach, describe, expect, it, vi } from "vitest";
import { DataUtils, PerspectiveCamera, SRGBColorSpace, Vector2, Vector4, WebGLRenderTarget } from "three";

import {
  captureViewport3DImage,
  registerViewport3DCapturePipeline,
  registerViewport3DCaptureSource,
  unpremultiplySrgbChannel,
  type Viewport3DCaptureSource,
} from "./viewport3dImageExport";

const unregister: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of unregister.splice(0)) cleanup();
  vi.restoreAllMocks();
});

function register(canvas: HTMLCanvasElement, source: Viewport3DCaptureSource): void {
  unregister.push(registerViewport3DCaptureSource(canvas, source));
}

function captureCanvas(width = 16, height = 12): HTMLCanvasElement {
  const canvas = offscreenCanvas(fakeCanvasDocument().document);
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function rendererFor(canvasWidth = 16, canvasHeight = 12, canvas?: HTMLCanvasElement) {
  let pixelRatio = 1.5;
  let logicalWidth = canvasWidth;
  let logicalHeight = canvasHeight;
  let clearAlpha = 0.5;
  const updateCanvasSize = () => {
    if (!canvas) return;
    canvas.width = Math.round(logicalWidth * pixelRatio);
    canvas.height = Math.round(logicalHeight * pixelRatio);
  };
  const renderer = {
    autoClear: false,
    autoClearColor: false,
    autoClearDepth: true,
    autoClearStencil: true,
    outputColorSpace: SRGBColorSpace,
    getClearAlpha: vi.fn(() => clearAlpha),
    getClearColor: vi.fn((target: { setHex: (value: number) => unknown }) => {
      target.setHex(0x123456);
      return target;
    }),
    getContext: vi.fn(() => ({ isContextLost: () => false })),
    getDrawingBufferSize: vi.fn((target: Vector2) => target.set(
      Math.round(logicalWidth * pixelRatio),
      Math.round(logicalHeight * pixelRatio),
    )),
    getPixelRatio: vi.fn(() => pixelRatio),
    getSize: vi.fn((target: Vector2) => target.set(logicalWidth, logicalHeight)),
    getRenderTarget: vi.fn(() => null),
    getScissor: vi.fn((target: Vector4) => target.set(2, 3, 8, 9)),
    getScissorTest: vi.fn(() => true),
    getViewport: vi.fn((target: Vector4) => target.set(1, 4, 10, 11)),
    readRenderTargetPixels: vi.fn((_target, _x, _y, width: number, height: number, pixels: Uint8Array) => {
      for (let index = 0; index < width * height; index += 1) {
        pixels[index * 4] = 64;
        pixels[index * 4 + 1] = 64;
        pixels[index * 4 + 2] = 64;
        pixels[index * 4 + 3] = 128;
      }
    }),
    clearDepth: vi.fn(),
    render: vi.fn(),
    setClearColor: vi.fn((_color: unknown, alpha: number) => { clearAlpha = alpha; }),
    setPixelRatio: vi.fn((nextPixelRatio: number) => {
      pixelRatio = nextPixelRatio;
      updateCanvasSize();
    }),
    setRenderTarget: vi.fn(),
    setScissor: vi.fn(),
    setScissorTest: vi.fn(),
    setViewport: vi.fn(),
    setSize: vi.fn((width: number, height: number, _updateStyle?: boolean) => {
      logicalWidth = width;
      logicalHeight = height;
      updateCanvasSize();
    }),
  };
  return renderer;
}

function fakeCanvasDocument(encodedBlob: Blob | null = new Blob(["png"], { type: "image/png" })): {
  context: {
    drawImage: ReturnType<typeof vi.fn>;
    getImageData: ReturnType<typeof vi.fn>;
    putImageData: ReturnType<typeof vi.fn>;
  };
  createdCanvases: HTMLCanvasElement[];
  document: Document;
} {
  const context = {
    createImageData: vi.fn((width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) })),
    drawImage: vi.fn(),
    getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let index = 0; index < width * height; index += 1) {
        data[index * 4] = 100;
        data[index * 4 + 1] = 100;
        data[index * 4 + 2] = 100;
        data[index * 4 + 3] = 255;
      }
      return { data };
    }),
    putImageData: vi.fn(),
  };
  const createdCanvases: HTMLCanvasElement[] = [];
  const createElement = vi.fn(() => {
    const outputCanvas = {
      height: 0,
      width: 0,
      getContext: vi.fn(() => context),
      toBlob: vi.fn((callback: BlobCallback) => callback(encodedBlob)),
    };
    createdCanvases.push(outputCanvas as unknown as HTMLCanvasElement);
    return outputCanvas;
  });
  const document = {
    createElement: createElement as unknown as Document["createElement"],
    defaultView: { getComputedStyle: vi.fn() },
  } as unknown as Document;
  return { context, createdCanvases, document };
}

function offscreenCanvas(documentRef: Document, width = 16, height = 12): HTMLCanvasElement {
  const rect = { left: 0, top: 0, width, height, right: width, bottom: height } as DOMRect;
  const root = { getBoundingClientRect: () => rect, querySelector: vi.fn(() => null) };
  return {
    height: 12,
    width: 16,
    ownerDocument: documentRef,
    closest: vi.fn(() => root),
    getBoundingClientRect: () => rect,
  } as HTMLCanvasElement;
}

function halfFloatFrame(width: number, height: number, rgba: [number, number, number, number]): { pixels: Uint16Array } {
  const pixels = new Uint16Array(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = DataUtils.toHalfFloat(rgba[0]);
    pixels[offset + 1] = DataUtils.toHalfFloat(rgba[1]);
    pixels[offset + 2] = DataUtils.toHalfFloat(rgba[2]);
    pixels[offset + 3] = DataUtils.toHalfFloat(rgba[3]);
  }
  return { pixels };
}

describe("unpremultiplySrgbChannel", () => {
  it("keeps opaque bytes unchanged and clears RGB for fully transparent pixels", () => {
    expect(unpremultiplySrgbChannel(137, 255)).toBe(137);
    expect(unpremultiplySrgbChannel(137, 0)).toBe(0);
  });

  it("unpremultiplies partially transparent sRGB in linear light", () => {
    // sRGB byte 137 represents linear 0.25; at alpha 128 it expands to about sRGB 187.
    expect(unpremultiplySrgbChannel(137, 128)).toBe(187);
    expect(unpremultiplySrgbChannel(255, 128)).toBe(255);
  });
});

describe("captureViewport3DImage", () => {
  it("reports a lost WebGL context with an actionable error", async () => {
    const canvas = captureCanvas();
    const renderer = rendererFor();
    renderer.getContext.mockReturnValue({ isContextLost: () => true });
    register(canvas, { camera: new PerspectiveCamera(), renderer: renderer as never, scene: {} as never });

    await expect(captureViewport3DImage(canvas, { background: "transparent", annotations: false }))
      .rejects.toThrow(/context was lost.*Reopen the viewport/i);
  });

  it("rejects an empty drawing buffer before allocating a render target", async () => {
    const canvas = captureCanvas(0, 0);
    const renderer = rendererFor(0, 0);
    register(canvas, { camera: new PerspectiveCamera(), renderer: renderer as never, scene: {} as never });

    await expect(captureViewport3DImage(canvas, { background: "view", annotations: false }))
      .rejects.toThrow(/drawing buffer is empty.*Resize the viewport/i);
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it("restores render, background, camera-layer, and clear state after an offscreen capture", async () => {
    const { document: documentRef } = fakeCanvasDocument();
    const canvas = offscreenCanvas(documentRef);
    const renderer = rendererFor();
    const camera = new PerspectiveCamera();
    camera.layers.enable(31);
    const originalMask = camera.layers.mask;
    const originalBackground = { isColor: true };
    const scene = { background: originalBackground };
    renderer.render.mockImplementation(() => {
      expect(scene.background).toBeNull();
      expect(camera.layers.mask & (1 << 31)).toBe(0);
    });
    register(canvas, { camera, renderer: renderer as never, scene: scene as never });
    const dispose = vi.spyOn(WebGLRenderTarget.prototype, "dispose");

    const blob = await captureViewport3DImage(canvas, { background: "transparent", annotations: false });

    expect(blob.type).toBe("image/png");
    expect(scene.background).toBe(originalBackground);
    expect(camera.layers.mask).toBe(originalMask);
    expect(renderer.setRenderTarget).toHaveBeenLastCalledWith(null);
    expect(renderer.setViewport).toHaveBeenLastCalledWith(expect.objectContaining({ x: 1, y: 4, z: 10, w: 11 }));
    expect(renderer.setScissor).toHaveBeenLastCalledWith(expect.objectContaining({ x: 2, y: 3, z: 8, w: 9 }));
    expect(renderer.setScissorTest).toHaveBeenLastCalledWith(true);
    expect(renderer.setClearColor).toHaveBeenLastCalledWith(expect.objectContaining({ r: expect.any(Number) }), 0.5);
    expect(renderer.autoClear).toBe(false);
    expect(renderer.autoClearColor).toBe(false);
    expect(renderer.autoClearDepth).toBe(true);
    expect(renderer.autoClearStencil).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("restores and disposes the offscreen target when scene rendering throws", async () => {
    const { document: documentRef } = fakeCanvasDocument();
    const canvas = offscreenCanvas(documentRef);
    const renderer = rendererFor();
    const camera = new PerspectiveCamera();
    camera.layers.enable(31);
    const originalMask = camera.layers.mask;
    const scene = { background: { isColor: true } };
    const originalBackground = scene.background;
    renderer.render.mockImplementation(() => {
      throw new Error("render failed");
    });
    register(canvas, { camera, renderer: renderer as never, scene: scene as never });
    const dispose = vi.spyOn(WebGLRenderTarget.prototype, "dispose");

    await expect(captureViewport3DImage(canvas, { background: "transparent", annotations: false }))
      .rejects.toThrow("render failed");

    expect(scene.background).toBe(originalBackground);
    expect(camera.layers.mask).toBe(originalMask);
    expect(renderer.setRenderTarget).toHaveBeenLastCalledWith(null);
    expect(renderer.autoClear).toBe(false);
    expect(renderer.autoClearColor).toBe(false);
    expect(renderer.autoClearDepth).toBe(true);
    expect(renderer.autoClearStencil).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("renders transparent annotations in a separate layer-31 pass after clearing depth", async () => {
    const { document: documentRef } = fakeCanvasDocument();
    const canvas = offscreenCanvas(documentRef);
    const renderer = rendererFor();
    const camera = new PerspectiveCamera();
    camera.layers.enable(31);
    const scene = { background: { isColor: true } };
    renderer.render.mockImplementation(() => {
      if (renderer.render.mock.calls.length === 1) {
        expect(camera.layers.mask).toBe(1 << 0);
      } else {
        expect(camera.layers.mask).toBe(1 << 31);
        expect(renderer.autoClear).toBe(false);
      }
      expect(scene.background).toBeNull();
    });
    register(canvas, { camera, renderer: renderer as never, scene: scene as never });

    const blob = await captureViewport3DImage(canvas, { background: "transparent", annotations: true });

    expect(blob.type).toBe("image/png");
    expect(renderer.render).toHaveBeenCalledTimes(2);
    expect(renderer.clearDepth).toHaveBeenCalledOnce();
    expect(camera.layers.mask).toBe(1 | (1 << 31));
  });

  it("uses the raw scene fallback when no capture pipeline is registered", async () => {
    const fakeDocument = fakeCanvasDocument();
    const canvas = offscreenCanvas(fakeDocument.document);
    const renderer = rendererFor();
    register(canvas, { camera: new PerspectiveCamera(), renderer: renderer as never, scene: {} as never });

    const blob = await captureViewport3DImage(canvas, { background: "view", annotations: false });

    expect(blob.type).toBe("image/png");
    expect(fakeDocument.createdCanvases).toHaveLength(2);
    expect(fakeDocument.context.drawImage).toHaveBeenCalledWith(fakeDocument.createdCanvases[0], 0, 0, 16, 12);
    expect(renderer.render).toHaveBeenCalledOnce();
  });

  it("does not let an old registration cleanup remove the replacement source", async () => {
    const canvas = captureCanvas();
    const oldSource = { camera: new PerspectiveCamera(), renderer: rendererFor() as never, scene: {} as never };
    const replacement = { camera: new PerspectiveCamera(), renderer: rendererFor() as never, scene: {} as never };
    const cleanupOld = registerViewport3DCaptureSource(canvas, oldSource);
    register(canvas, replacement);
    cleanupOld();
    (replacement.renderer as ReturnType<typeof rendererFor>).getContext.mockReturnValue({ isContextLost: () => true });

    await expect(captureViewport3DImage(canvas, { background: "view", annotations: true }))
      .rejects.toThrow(/context was lost/i);
  });

  it.each([
    { background: "view", scale: 1 },
    { background: "view", scale: 2 },
    { background: "view", scale: 4 },
    { background: "transparent", scale: 1 },
    { background: "transparent", scale: 2 },
    { background: "transparent", scale: 4 },
  ] as const)("renders a $scale x CSS-sized $background PNG through the composed capture pipeline", async ({ background, scale }) => {
    const fakeDocument = fakeCanvasDocument();
    const canvas = offscreenCanvas(fakeDocument.document);
    const renderer = rendererFor(16, 12, canvas);
    const source = { camera: new PerspectiveCamera(), renderer: renderer as never, scene: { background: { isColor: true } } as never };
    const pipeline = { resize: vi.fn(), render: vi.fn() };
    register(canvas, source);
    unregister.push(registerViewport3DCapturePipeline(canvas, pipeline));

    const blob = await captureViewport3DImage(canvas, { background, annotations: true, scale });

    expect(blob.type).toBe("image/png");
    expect(fakeDocument.createdCanvases[0]).toMatchObject({ width: 16 * scale, height: 12 * scale });
    expect(pipeline.resize).toHaveBeenNthCalledWith(1, 16 * scale, 12 * scale);
    expect(pipeline.render).toHaveBeenNthCalledWith(1, { annotations: true, pixels: true });
    expect(pipeline.render).toHaveBeenLastCalledWith({ annotations: true });
    expect(renderer.setPixelRatio).toHaveBeenNthCalledWith(1, 1);
    expect(renderer.setPixelRatio).toHaveBeenLastCalledWith(1.5);
    expect(renderer.setSize).toHaveBeenNthCalledWith(1, 16 * scale, 12 * scale, false);
    expect(renderer.setSize).toHaveBeenLastCalledWith(16, 12, false);
    expect(fakeDocument.context.drawImage).toHaveBeenCalledWith(canvas, 0, 0, 16 * scale, 12 * scale);
  });

  it.each(["view", "transparent"] as const)("uses the same postprocessed pipeline for %s background", async (background) => {
    const fakeDocument = fakeCanvasDocument();
    const canvas = offscreenCanvas(fakeDocument.document);
    const renderer = rendererFor(16, 12, canvas);
    const originalBackground = { isColor: true };
    const scene = { background: originalBackground };
    const camera = new PerspectiveCamera();
    camera.layers.enable(31);
    const source = { camera, renderer: renderer as never, scene: scene as never };
    const pipeline = { resize: vi.fn(), render: vi.fn() };
    register(canvas, source);
    unregister.push(registerViewport3DCapturePipeline(canvas, pipeline));

    await captureViewport3DImage(canvas, { background, annotations: false, scale: 2 });

    expect(pipeline.render).toHaveBeenCalledTimes(2);
    expect(pipeline.render).toHaveBeenNthCalledWith(1, { annotations: false, pixels: true });
    expect(scene.background).toBe(originalBackground);
    expect(renderer.getClearAlpha()).toBe(0.5);
    expect(renderer.render).toHaveBeenCalledTimes(background === "transparent" ? 1 : 0);
  });

  it("renders the full export viewport even when the live renderer retained selective clears", async () => {
    const fakeDocument = fakeCanvasDocument();
    const canvas = offscreenCanvas(fakeDocument.document);
    const renderer = rendererFor(16, 12, canvas);
    let calls = 0;
    register(canvas, { camera: new PerspectiveCamera(), renderer: renderer as never, scene: { background: null } as never });
    unregister.push(registerViewport3DCapturePipeline(canvas, {
      resize: vi.fn(),
      render: () => {
        if (calls++ === 0) {
          expect(renderer.autoClearColor).toBe(true);
          expect(renderer.autoClearDepth).toBe(true);
          expect(renderer.setScissorTest).toHaveBeenLastCalledWith(false);
        }
      },
    }));
    await captureViewport3DImage(canvas, { background: "view", annotations: false, scale: 2 });
    expect(renderer.autoClearColor).toBe(false);
    expect(renderer.setScissorTest).toHaveBeenLastCalledWith(true);
  });

  it("keeps transparent clearing active only during the capture render", async () => {
    const fakeDocument = fakeCanvasDocument();
    const canvas = offscreenCanvas(fakeDocument.document);
    const renderer = rendererFor(16, 12, canvas);
    const originalBackground = { isColor: true };
    const scene = { background: originalBackground };
    const camera = new PerspectiveCamera();
    camera.layers.enable(31);
    const source = { camera, renderer: renderer as never, scene: scene as never };
    const pipeline = {
      resize: vi.fn(),
      render: vi.fn(({ annotations }: { annotations: boolean }) => {
        if (pipeline.render.mock.calls.length === 1) {
          expect(scene.background).toBeNull();
          expect(renderer.getClearAlpha()).toBe(0);
          expect(annotations).toBe(false);
        }
      }),
    };
    register(canvas, source);
    unregister.push(registerViewport3DCapturePipeline(canvas, pipeline));

    renderer.render.mockImplementation(() => expect(camera.layers.mask).toBe(1 << 0));
    await captureViewport3DImage(canvas, { background: "transparent", annotations: false, scale: 2 });

    expect(scene.background).toBe(originalBackground);
    expect(renderer.getClearAlpha()).toBe(0.5);
    expect(renderer.render).toHaveBeenCalledOnce();
    expect(renderer.clearDepth).not.toHaveBeenCalled();
    const pixels = fakeDocument.context.putImageData.mock.calls.at(-1)?.[0] as ImageData | undefined;
    expect(pixels?.data[3]).toBe(128);
    expect(pixels?.data[0]).toBe(unpremultiplySrgbChannel(100, 128));
  });

  it("preserves additive glow outside raw geometry in transparent captures", async () => {
    const fakeDocument = fakeCanvasDocument();
    const canvas = offscreenCanvas(fakeDocument.document);
    const renderer = rendererFor(16, 12, canvas);
    renderer.readRenderTargetPixels.mockImplementation((_target, _x, _y, _width, _height, pixels: Uint8Array) => pixels.fill(0));
    register(canvas, { camera: new PerspectiveCamera(), renderer: renderer as never, scene: { background: null } as never });
    unregister.push(registerViewport3DCapturePipeline(canvas, { resize: vi.fn(), render: vi.fn() }));
    await captureViewport3DImage(canvas, { background: "transparent", annotations: false });
    const pixels = fakeDocument.context.putImageData.mock.calls.at(-1)?.[0] as ImageData;
    // Fake beauty contains sRGB 100, while the independent geometry pass is empty.
    expect(pixels.data[3]).toBeGreaterThan(0);
    expect(pixels.data[3]).toBeLessThan(255);
    expect(pixels.data[0]).toBeGreaterThan(245);
  });

  it.each(["view", "transparent"] as const)("uses matching composed RGBA16F samples for %s color and alpha", async (background) => {
    const fakeDocument = fakeCanvasDocument();
    const canvas = offscreenCanvas(fakeDocument.document);
    const renderer = rendererFor(16, 12, canvas);
    const frame = halfFloatFrame(16, 12, [0.125, 0.03125, 0, 0.25]);
    const pipeline = { resize: vi.fn(), render: vi.fn().mockReturnValueOnce(frame) };
    register(canvas, { camera: new PerspectiveCamera(), renderer: renderer as never, scene: { background: null } as never });
    unregister.push(registerViewport3DCapturePipeline(canvas, pipeline));

    await captureViewport3DImage(canvas, { background, annotations: false });

    const image = fakeDocument.context.putImageData.mock.calls.at(-1)?.[0] as ImageData;
    expect(pipeline.render).toHaveBeenNthCalledWith(1, { annotations: false, pixels: true });
    expect(image.data[0]).toBe(188);
    expect(image.data[1]).toBe(99);
    expect(image.data[3]).toBe(64);
    expect(renderer.render).not.toHaveBeenCalled();
    expect(renderer.readRenderTargetPixels).not.toHaveBeenCalled();
  });

  it("retains transparent additive glow from a composed frame with zero coverage", async () => {
    const fakeDocument = fakeCanvasDocument();
    const canvas = offscreenCanvas(fakeDocument.document);
    const renderer = rendererFor(16, 12, canvas);
    const pipeline = {
      resize: vi.fn(),
      render: vi.fn().mockReturnValueOnce(halfFloatFrame(16, 12, [0.125, 0.03125, 0, 0])),
    };
    register(canvas, { camera: new PerspectiveCamera(), renderer: renderer as never, scene: { background: null } as never });
    unregister.push(registerViewport3DCapturePipeline(canvas, pipeline));

    await captureViewport3DImage(canvas, { background: "transparent", annotations: false });

    const image = fakeDocument.context.putImageData.mock.calls.at(-1)?.[0] as ImageData;
    expect(image.data[0]).toBe(255);
    expect(image.data[1]).toBeGreaterThan(0);
    expect(image.data[1]).toBeLessThan(255);
    expect(image.data[3]).toBe(32);
    expect(renderer.render).not.toHaveBeenCalled();
    expect(renderer.readRenderTargetPixels).not.toHaveBeenCalled();
  });

  it("preserves faint additive light after quantizing its PNG coverage", async () => {
    const fakeDocument = fakeCanvasDocument();
    const canvas = offscreenCanvas(fakeDocument.document);
    const renderer = rendererFor(16, 12, canvas);
    register(canvas, { camera: new PerspectiveCamera(), renderer: renderer as never, scene: { background: null } as never });
    unregister.push(registerViewport3DCapturePipeline(canvas, {
      resize: vi.fn(), render: vi.fn().mockReturnValueOnce(halfFloatFrame(16, 12, [1 / 1024, 0, 0, 0])),
    }));
    await captureViewport3DImage(canvas, { background: "transparent", annotations: false });
    const image = fakeDocument.context.putImageData.mock.calls.at(-1)?.[0] as ImageData;
    expect(image.data[3]).toBe(1);
    expect(image.data[0]).toBe(137);
  });

  it("preserves additive light mixed with partial geometry coverage", async () => {
    const fakeDocument = fakeCanvasDocument();
    const canvas = offscreenCanvas(fakeDocument.document);
    const renderer = rendererFor(16, 12, canvas);
    register(canvas, { camera: new PerspectiveCamera(), renderer: renderer as never, scene: { background: null } as never });
    unregister.push(registerViewport3DCapturePipeline(canvas, {
      resize: vi.fn(), render: vi.fn().mockReturnValueOnce(halfFloatFrame(16, 12, [0.2, 0, 0, 0.01])),
    }));
    await captureViewport3DImage(canvas, { background: "transparent", annotations: false });
    const image = fakeDocument.context.putImageData.mock.calls.at(-1)?.[0] as ImageData;
    expect(image.data[3]).toBe(51);
    expect(image.data[0]).toBe(255);
    expect(image.data[0]! / 255 * image.data[3]! / 255).toBeCloseTo(0.2, 3);
  });

  it.each(["short pixel buffer", "non-finite pixel data"] as const)(
    "rejects a composed frame with %s and restores the live renderer",
    async (failure) => {
      const fakeDocument = fakeCanvasDocument();
      const canvas = offscreenCanvas(fakeDocument.document);
      const renderer = rendererFor(16, 12, canvas);
      const camera = new PerspectiveCamera();
      camera.layers.enable(31);
      const originalMask = camera.layers.mask;
      const originalBackground = { isColor: true };
      const scene = { background: originalBackground };
      const frame = halfFloatFrame(32, 24, [0, 0, 0, 1]);
      if (failure === "short pixel buffer") frame.pixels = new Uint16Array(4);
      else frame.pixels[0] = 0x7c00;
      const pipeline = { resize: vi.fn(), render: vi.fn().mockReturnValueOnce(frame) };
      register(canvas, { camera, renderer: renderer as never, scene: scene as never });
      unregister.push(registerViewport3DCapturePipeline(canvas, pipeline));

      await expect(captureViewport3DImage(canvas, { background: "transparent", annotations: false, scale: 2 }))
        .rejects.toThrow(failure === "short pixel buffer" ? /invalid composed capture frame.*expected 3072/i : /non-finite.*RGBA16F/i);

      expect(fakeDocument.createdCanvases).toHaveLength(0);
      expect(renderer.getPixelRatio()).toBe(1.5);
      expect(renderer.getSize(new Vector2()).toArray()).toEqual([16, 12]);
      expect(canvas.width).toBe(24);
      expect(canvas.height).toBe(18);
      expect(scene.background).toBe(originalBackground);
      expect(camera.layers.mask).toBe(originalMask);
      expect(pipeline.render).toHaveBeenNthCalledWith(1, { annotations: false, pixels: true });
      expect(pipeline.render).toHaveBeenLastCalledWith({ annotations: true });
    },
  );

  it("does not composite DOM annotations when annotations are disabled", async () => {
    const fakeDocument = fakeCanvasDocument();
    const canvas = offscreenCanvas(fakeDocument.document);
    const renderer = rendererFor(16, 12, canvas);
    const source = { camera: new PerspectiveCamera(), renderer: renderer as never, scene: {} as never };
    const pipeline = { resize: vi.fn(), render: vi.fn() };
    register(canvas, source);
    unregister.push(registerViewport3DCapturePipeline(canvas, pipeline));

    await captureViewport3DImage(canvas, { background: "view", annotations: false, scale: 2 });

    expect(pipeline.render).toHaveBeenNthCalledWith(1, { annotations: false, pixels: true });
    expect(canvas.closest(".fm-viewport-3d")?.querySelector).not.toHaveBeenCalled();
  });

  it("renders raw fallback captures at the requested physical size when no pipeline is registered", async () => {
    const fakeDocument = fakeCanvasDocument();
    const canvas = offscreenCanvas(fakeDocument.document);
    const renderer = rendererFor(16, 12);
    register(canvas, { camera: new PerspectiveCamera(), renderer: renderer as never, scene: {} as never });

    const blob = await captureViewport3DImage(canvas, { background: "transparent", annotations: false, scale: 2 });

    expect(blob.type).toBe("image/png");
    expect(renderer.readRenderTargetPixels).toHaveBeenCalledWith(expect.any(WebGLRenderTarget), 0, 0, 32, 24, expect.any(Uint8Array));
    expect(fakeDocument.createdCanvases[0]).toMatchObject({ width: 32, height: 24 });
  });

  it.each([
    { width: 4500, height: 2, scale: 2, message: /8192 pixels per side/ },
    { width: 2048, height: 2048, scale: 4, message: /16 million pixels/ },
  ])("rejects out-of-budget output before rendering or allocating an image canvas", async ({ width, height, scale, message }) => {
    const fakeDocument = fakeCanvasDocument();
    const canvas = offscreenCanvas(fakeDocument.document, width, height);
    const renderer = rendererFor(16, 12, canvas);
    const pipeline = { resize: vi.fn(), render: vi.fn() };
    register(canvas, { camera: new PerspectiveCamera(), renderer: renderer as never, scene: {} as never });
    unregister.push(registerViewport3DCapturePipeline(canvas, pipeline));

    await expect(captureViewport3DImage(canvas, { background: "view", annotations: false, scale }))
      .rejects.toThrow(message);

    expect(pipeline.render).not.toHaveBeenCalled();
    expect(fakeDocument.createdCanvases).toHaveLength(0);
  });

  it("rejects unsupported capture scales", async () => {
    const canvas = captureCanvas();
    const renderer = rendererFor();
    register(canvas, { camera: new PerspectiveCamera(), renderer: renderer as never, scene: {} as never });

    await expect(captureViewport3DImage(canvas, { background: "view", annotations: false, scale: 1.5 }))
      .rejects.toThrow(/scale must be 1, 2, or 4/i);
  });

  it("respects the device renderbuffer limit before resizing the live renderer", async () => {
    const fakeDocument = fakeCanvasDocument();
    const canvas = offscreenCanvas(fakeDocument.document);
    const renderer = rendererFor(16, 12, canvas);
    renderer.getContext.mockReturnValue({ isContextLost: () => false, MAX_RENDERBUFFER_SIZE: 0x84e8, getParameter: () => 24 } as never);
    register(canvas, { camera: new PerspectiveCamera(), renderer: renderer as never, scene: {} as never });
    await expect(captureViewport3DImage(canvas, { background: "view", annotations: false, scale: 2 })).rejects.toThrow(/up to 24 pixels/);
    expect(renderer.setSize).not.toHaveBeenCalled();
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it("restores renderer and pipeline after a render failure", async () => {
    const canvas = captureCanvas();
    const renderer = rendererFor(16, 12, canvas);
    const source = { camera: new PerspectiveCamera(), renderer: renderer as never, scene: {} as never };
    const pipeline = { resize: vi.fn(), render: vi.fn().mockImplementationOnce(() => { throw new Error("capture render failed"); }) };
    register(canvas, source);
    unregister.push(registerViewport3DCapturePipeline(canvas, pipeline));

    await expect(captureViewport3DImage(canvas, { background: "view", annotations: false, scale: 4 }))
      .rejects.toThrow("capture render failed");

    expect(renderer.getPixelRatio()).toBe(1.5);
    expect(renderer.getSize(new Vector2()).toArray()).toEqual([16, 12]);
    expect(canvas.width).toBe(24);
    expect(canvas.height).toBe(18);
    expect(pipeline.resize).toHaveBeenLastCalledWith(24, 18);
    expect(pipeline.render).toHaveBeenNthCalledWith(1, { annotations: false, pixels: true });
    expect(pipeline.render).toHaveBeenLastCalledWith({ annotations: true });
  });

  it("restores the renderer and live pipeline when PNG encoding fails", async () => {
    const fakeDocument = fakeCanvasDocument(null);
    const canvas = offscreenCanvas(fakeDocument.document);
    const renderer = rendererFor(16, 12, canvas);
    const source = { camera: new PerspectiveCamera(), renderer: renderer as never, scene: {} as never };
    const pipeline = { resize: vi.fn(), render: vi.fn() };
    register(canvas, source);
    unregister.push(registerViewport3DCapturePipeline(canvas, pipeline));

    await expect(captureViewport3DImage(canvas, { background: "view", annotations: false, scale: 2 }))
      .rejects.toThrow(/could not encode.*PNG/i);

    expect(renderer.getPixelRatio()).toBe(1.5);
    expect(renderer.getSize(new Vector2()).toArray()).toEqual([16, 12]);
    expect(canvas.width).toBe(24);
    expect(canvas.height).toBe(18);
    expect(pipeline.render).toHaveBeenNthCalledWith(1, { annotations: false, pixels: true });
    expect(pipeline.render).toHaveBeenLastCalledWith({ annotations: true });
  });

  it("does not let an old pipeline cleanup remove a replacement pipeline", async () => {
    const canvas = captureCanvas();
    const renderer = rendererFor(16, 12, canvas);
    const source = { camera: new PerspectiveCamera(), renderer: renderer as never, scene: {} as never };
    const oldPipeline = { resize: vi.fn(), render: vi.fn() };
    const replacement = { resize: vi.fn(), render: vi.fn() };
    register(canvas, source);
    const cleanupOld = registerViewport3DCapturePipeline(canvas, oldPipeline);
    unregister.push(registerViewport3DCapturePipeline(canvas, replacement));
    cleanupOld();

    await captureViewport3DImage(canvas, { background: "view", annotations: false, scale: 1 });

    expect(oldPipeline.render).not.toHaveBeenCalled();
    expect(replacement.render).toHaveBeenCalled();
  });
});
