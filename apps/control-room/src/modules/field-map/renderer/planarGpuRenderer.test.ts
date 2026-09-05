import { describe, expect, it, vi } from "vitest";

import { createPlanarGpuRenderer } from "./planarGpuRenderer";

function createMockWebGLCanvas(): {
  canvas: HTMLCanvasElement;
  listeners: Map<string, (event: any) => void>;
} {
  const listeners = new Map<string, (event: any) => void>();
  const gl = {
    COLOR_BUFFER_BIT: 16384,
    DEPTH_BUFFER_BIT: 256,
    RGBA: 6408,
    RGBA32F: 34836,
    STENCIL_BUFFER_BIT: 1024,
    TEXTURE_2D: 3553,
    UNSIGNED_BYTE: 5121,
    bindTexture: vi.fn(),
    canvas: null as any,
    clear: vi.fn(),
    clearColor: vi.fn(),
    createBuffer: vi.fn(() => ({})),
    createFramebuffer: vi.fn(() => ({})),
    createProgram: vi.fn(() => ({})),
    createRenderbuffer: vi.fn(() => ({})),
    createShader: vi.fn(() => ({})),
    createTexture: vi.fn(() => ({})),
    deleteBuffer: vi.fn(),
    deleteFramebuffer: vi.fn(),
    deleteProgram: vi.fn(),
    deleteRenderbuffer: vi.fn(),
    deleteShader: vi.fn(),
    deleteTexture: vi.fn(),
    disable: vi.fn(),
    drawArrays: vi.fn(),
    drawElements: vi.fn(),
    enable: vi.fn(),
    getExtension: vi.fn(() => null),
    getParameter: vi.fn((param) => {
      if (param === 3379) return 4096; // MAX_TEXTURE_SIZE
      if (param === 34921) return 16; // MAX_VERTEX_ATTRIBS
      if (param === 34930) return 16; // MAX_TEXTURE_IMAGE_UNITS
      if (param === 35661) return 32; // MAX_COMBINED_TEXTURE_IMAGE_UNITS
      return 0;
    }),
    getShaderPrecisionFormat: vi.fn(() => ({ precision: 23, rangeMax: 127, rangeMin: 126 })),
    isContextLost: vi.fn(() => false),
    pixelStorei: vi.fn(),
    texImage2D: vi.fn(),
    texParameteri: vi.fn(),
    useProgram: vi.fn(),
    viewport: vi.fn(),
  };

  const canvas = {
    addEventListener: vi.fn((name: string, fn: (event: any) => void) => {
      listeners.set(name, fn);
    }),
    getContext: vi.fn((type: string) => {
      if (type === "webgl2" || type === "webgl") return gl;
      return null;
    }),
    height: 100,
    removeEventListener: vi.fn((name: string) => {
      listeners.delete(name);
    }),
    style: {},
    width: 200,
  } as unknown as HTMLCanvasElement;
  gl.canvas = canvas;

  return { canvas, listeners };
}

function createMockRenderer(canvas: HTMLCanvasElement): any {
  return {
    autoClear: false,
    clear: vi.fn(),
    dispose: vi.fn(),
    domElement: canvas,
    outputColorSpace: "",
    render: vi.fn(),
    setSize: vi.fn(),
    toneMapping: 0,
  };
}

describe("planarGpuRenderer", () => {
  it("returns null when WebGL context is unavailable on canvas", () => {
    const canvas = {
      getContext: vi.fn(() => null),
    } as unknown as HTMLCanvasElement;

    const renderer = createPlanarGpuRenderer(canvas);
    expect(renderer).toBeNull();
  });

  it("initializes PlanarGpuRenderer and reports renderer kind 'gpu'", () => {
    const { canvas } = createMockWebGLCanvas();
    const renderer = createPlanarGpuRenderer(canvas, (params) => createMockRenderer(params.canvas));
    expect(renderer).not.toBeNull();
    expect(renderer?.getRendererKind()).toBe("gpu");
    expect(renderer?.isContextLost()).toBe(false);
    renderer?.dispose();
  });

  it("maps fit, pan, and zoom in physical coordinate space", () => {
    const { canvas } = createMockWebGLCanvas();
    const renderer = createPlanarGpuRenderer(canvas, (params) => createMockRenderer(params.canvas));
    if (!renderer) throw new Error("Renderer initialization failed");

    const viewport = renderer.resolveViewport([0, 10, 0, 20], {
      panU: 2,
      panV: -4,
      zoom: 2,
    });

    // centerU = 5 + 2 = 7, halfU = 10 / 4 = 2.5 -> [4.5, 9.5]
    // centerV = 10 - 4 = 6, halfV = 20 / 4 = 5 -> [1, 11]
    expect(viewport[0]).toBeCloseTo(4.5);
    expect(viewport[1]).toBeCloseTo(9.5);
    expect(viewport[2]).toBeCloseTo(1);
    expect(viewport[3]).toBeCloseTo(11);

    renderer.dispose();
  });

  it("handles webglcontextlost and webglcontextrestored lifecycle events", () => {
    const { canvas, listeners } = createMockWebGLCanvas();
    const renderer = createPlanarGpuRenderer(canvas, (params) => createMockRenderer(params.canvas));
    if (!renderer) throw new Error("Renderer initialization failed");

    expect(renderer.isContextLost()).toBe(false);

    // Trigger context lost
    const preventDefault = vi.fn();
    listeners.get("webglcontextlost")?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(renderer.isContextLost()).toBe(true);

    // In lost context state, draw operations safely no-op
    expect(() => renderer.draw(new Uint8ClampedArray(16), 2, 2)).not.toThrow();

    // Trigger context restored
    listeners.get("webglcontextrestored")?.({});
    expect(renderer.isContextLost()).toBe(false);

    renderer.dispose();
  });

  it("executes 100 consecutive resize and setViewport interactions without leaking", () => {
    const { canvas } = createMockWebGLCanvas();
    const renderer = createPlanarGpuRenderer(canvas, (params) => createMockRenderer(params.canvas));
    if (!renderer) throw new Error("Renderer initialization failed");

    for (let i = 0; i < 100; i++) {
      renderer.resize(100 + i, 80 + i, 2);
      renderer.setViewport([0, 1, 0, 1], [i * 0.01, 1 + i * 0.01, 0, 1]);
    }

    expect(canvas.width).toBe(398); // (100 + 99) * 2
    expect(canvas.height).toBe(358); // (80 + 99) * 2

    renderer.dispose();
  });

  it("draws and clears base raster texture and layers", () => {
    const { canvas } = createMockWebGLCanvas();
    const renderer = createPlanarGpuRenderer(canvas, (params) => createMockRenderer(params.canvas));
    if (!renderer) throw new Error("Renderer initialization failed");

    renderer.setViewport([0, 10, 0, 10], [0, 10, 0, 10]);

    // Draw reduction raster
    const pixels = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
    expect(() => renderer.draw(pixels, 2, 1)).not.toThrow();

    // Clear base
    expect(() => renderer.clearBase()).not.toThrow();

    renderer.dispose();
  });
});
