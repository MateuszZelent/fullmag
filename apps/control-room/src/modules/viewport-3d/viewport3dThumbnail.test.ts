import { describe, expect, it, vi } from "vitest";

import {
  VIEWPORT_3D_THUMBNAIL_MAX_BYTES,
  VIEWPORT_3D_THUMBNAIL_SIZES,
  captureViewport3DThumbnail,
  fitThumbnailToBudget,
  isBlankThumbnailFrame,
  resolveViewport3DThumbnailColouring,
  viewport3DThumbnailCrop,
} from "./viewport3dThumbnail";
import {
  captureRegisteredViewport3DThumbnail,
  registerViewport3DThumbnailCapture,
} from "./viewport3dThumbnailRegistry";

type ColouringInput = Parameters<typeof resolveViewport3DThumbnailColouring>[0];

function settings(overrides: Partial<ColouringInput> = {}): ColouringInput {
  return {
    activeQuantityId: "m",
    scalarColorPalette: "viridis",
    shaderVisible: true,
    surfaceColorSource: "orientation",
    vectorColorMode: "orientation",
    vectorsVisible: false,
    ...overrides,
  };
}

describe("viewport3DThumbnailCrop", () => {
  it("takes the centred 16:10 window of wide and tall sources", () => {
    expect(viewport3DThumbnailCrop(800, 600)).toEqual({ height: 500, width: 800, x: 0, y: 50 });
    expect(viewport3DThumbnailCrop(1600, 600)).toEqual({ height: 600, width: 960, x: 320, y: 0 });
    expect(viewport3DThumbnailCrop(600, 800)).toEqual({ height: 375, width: 600, x: 0, y: 212 });
    expect(viewport3DThumbnailCrop(320, 200)).toEqual({ height: 200, width: 320, x: 0, y: 0 });
  });

  it("rejects zero-sized and non-finite sources", () => {
    expect(viewport3DThumbnailCrop(0, 600)).toBeNull();
    expect(viewport3DThumbnailCrop(800, 0)).toBeNull();
    expect(viewport3DThumbnailCrop(Number.NaN, 600)).toBeNull();
  });

  it("keeps the ladder at 16:10", () => {
    for (const size of VIEWPORT_3D_THUMBNAIL_SIZES) {
      expect(size.width / size.height).toBeCloseTo(1.6, 5);
    }
  });
});

describe("resolveViewport3DThumbnailColouring", () => {
  it("names the HSL sphere for orientation maps from the surface or the vectors", () => {
    expect(resolveViewport3DThumbnailColouring(settings())).toBe("hsl-sphere");
    expect(
      resolveViewport3DThumbnailColouring(
        settings({ shaderVisible: false, vectorsVisible: true, vectorColorMode: "orientation" }),
      ),
    ).toBe("hsl-sphere");
  });

  it("names the diverging mz map only for the z component of m with a diverging palette", () => {
    const mz = settings({ scalarColorPalette: "coolwarm", surfaceColorSource: "component_z" });
    expect(resolveViewport3DThumbnailColouring(mz)).toBe("mz-diverging");
    expect(resolveViewport3DThumbnailColouring({ ...mz, activeQuantityId: "H_eff" })).toBe("none");
    expect(resolveViewport3DThumbnailColouring({ ...mz, surfaceColorSource: "component_x" })).toBe(
      "none",
    );
  });

  it("names viridis scalar maps and refuses to relabel other palettes", () => {
    expect(
      resolveViewport3DThumbnailColouring(settings({ surfaceColorSource: "component_x" })),
    ).toBe("scalar-viridis");
    expect(
      resolveViewport3DThumbnailColouring(settings({ surfaceColorSource: "colormap" })),
    ).toBe("scalar-viridis");
    expect(
      resolveViewport3DThumbnailColouring(
        settings({ scalarColorPalette: "inferno", surfaceColorSource: "colormap" }),
      ),
    ).toBe("none");
  });

  it("is none for a solid surface without coloured vectors or a monochrome mode", () => {
    expect(
      resolveViewport3DThumbnailColouring(settings({ surfaceColorSource: "solid" })),
    ).toBe("none");
    expect(
      resolveViewport3DThumbnailColouring(
        settings({ surfaceColorSource: "solid", vectorsVisible: true, vectorColorMode: "monochrome" }),
      ),
    ).toBe("none");
    expect(resolveViewport3DThumbnailColouring(settings({ shaderVisible: false }))).toBe("none");
  });
});

describe("isBlankThumbnailFrame", () => {
  it("flags cleared, uniform and empty buffers but not a rendered frame", () => {
    expect(isBlankThumbnailFrame(new Uint8ClampedArray(16))).toBe(true);
    expect(isBlankThumbnailFrame(new Uint8ClampedArray([5, 5, 5, 255, 5, 5, 5, 255]))).toBe(true);
    expect(isBlankThumbnailFrame([])).toBe(true);
    expect(isBlankThumbnailFrame(new Uint8ClampedArray([5, 5, 5, 255, 9, 5, 5, 255]))).toBe(false);
    expect(isBlankThumbnailFrame(new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 255]))).toBe(false);
  });
});

describe("fitThumbnailToBudget", () => {
  it("returns the largest encoding that fits and stops encoding there", async () => {
    const sizes = [300_000, 260_000, 120_000, 40_000];
    const encode = vi.fn(async ({ width }: { width: number }) => ({
      size: sizes[VIEWPORT_3D_THUMBNAIL_SIZES.findIndex((entry) => entry.width === width)],
    }));
    const fitted = await fitThumbnailToBudget(encode, VIEWPORT_3D_THUMBNAIL_MAX_BYTES);
    expect(fitted).toMatchObject({ height: 120, size: 120_000, width: 192 });
    expect(encode).toHaveBeenCalledTimes(3);
  });

  it("gives up when no size fits or encoding fails", async () => {
    expect(await fitThumbnailToBudget(async () => ({ size: 999_999 }), 1000)).toBeNull();
    expect(await fitThumbnailToBudget(async () => null, 1000)).toBeNull();
    expect(await fitThumbnailToBudget(async () => ({ size: 0 }), 1000)).toBeNull();
  });
});

interface FakeSurface {
  height: number;
  width: number;
  drawImage: ReturnType<typeof vi.fn>;
  getContext: ReturnType<typeof vi.fn>;
  toBlob: (callback: (blob: Blob | null) => void) => void;
}

function fakeSurface(blobSize: (width: number) => number, pixels?: Uint8ClampedArray): FakeSurface {
  const surface: FakeSurface = {
    drawImage: vi.fn(),
    getContext: vi.fn(),
    height: 0,
    toBlob: (callback) => callback(new Blob([new Uint8Array(blobSize(surface.width))])),
    width: 0,
  };
  surface.getContext.mockImplementation(() => ({
    drawImage: surface.drawImage,
    getImageData: () => ({
      data: pixels ?? new Uint8ClampedArray([1, 2, 3, 255, 9, 8, 7, 255]),
    }),
  }));
  return surface;
}

function fakeGlCanvas(options: { lost?: boolean; size?: [number, number] } = {}) {
  const [width, height] = options.size ?? [800, 600];
  const gl = {
    drawingBufferHeight: height,
    drawingBufferWidth: width,
    isContextLost: () => options.lost ?? false,
  };
  return {
    getContext: vi.fn((type: string) => (type === "webgl2" ? gl : null)),
    height,
    width,
  };
}

describe("captureViewport3DThumbnail", () => {
  it("renders, copies the 16:10 crop and returns a PNG within the budget", async () => {
    const order: string[] = [];
    const canvas = fakeGlCanvas();
    const surfaces: FakeSurface[] = [];
    const createCanvas = () => {
      const surface = fakeSurface((width) => (width === 320 ? 300_000 : 10_000));
      surfaces.push(surface);
      return surface as unknown as HTMLCanvasElement;
    };
    const thumbnail = await captureViewport3DThumbnail({
      canvas: canvas as unknown as HTMLCanvasElement,
      colouring: "hsl-sphere",
      createCanvas,
      render: () => order.push("render"),
    });

    expect(order).toEqual(["render"]);
    expect(surfaces[0].drawImage).toHaveBeenCalledWith(canvas, 0, 50, 800, 500, 0, 0, 320, 200);
    expect(thumbnail).toMatchObject({ colouring: "hsl-sphere", height: 160, width: 256 });
    expect(thumbnail?.pngBase64.length).toBeGreaterThan(0);
  });

  it("is null for a missing canvas, zero size, lost context, blank frame or render failure", async () => {
    const colouring = "none" as const;
    const base = { colouring, createCanvas: () => fakeSurface(() => 10) as unknown as HTMLCanvasElement };
    expect(await captureViewport3DThumbnail({ ...base, canvas: null })).toBeNull();
    expect(
      await captureViewport3DThumbnail({
        ...base,
        canvas: fakeGlCanvas({ size: [0, 0] }) as unknown as HTMLCanvasElement,
      }),
    ).toBeNull();
    expect(
      await captureViewport3DThumbnail({
        ...base,
        canvas: fakeGlCanvas({ lost: true }) as unknown as HTMLCanvasElement,
      }),
    ).toBeNull();
    expect(
      await captureViewport3DThumbnail({
        canvas: fakeGlCanvas() as unknown as HTMLCanvasElement,
        colouring,
        createCanvas: () =>
          fakeSurface(() => 10, new Uint8ClampedArray(16)) as unknown as HTMLCanvasElement,
      }),
    ).toBeNull();
    expect(
      await captureViewport3DThumbnail({
        ...base,
        canvas: fakeGlCanvas() as unknown as HTMLCanvasElement,
        render: () => {
          throw new Error("context lost");
        },
      }),
    ).toBeNull();
  });

  it("is null when even the smallest size exceeds the budget", async () => {
    expect(
      await captureViewport3DThumbnail({
        canvas: fakeGlCanvas() as unknown as HTMLCanvasElement,
        colouring: "none",
        createCanvas: () => fakeSurface(() => 400_000) as unknown as HTMLCanvasElement,
      }),
    ).toBeNull();
  });
});

describe("thumbnail registry", () => {
  const thumbnail = { colouring: "none" as const, height: 200, pngBase64: "AA==", width: 320 };

  it("returns the newest registration that yields a thumbnail and tolerates failures", async () => {
    expect(await captureRegisteredViewport3DThumbnail()).toBeNull();
    const first = registerViewport3DThumbnailCapture("a", async () => thumbnail);
    const second = registerViewport3DThumbnailCapture("b", async () => {
      throw new Error("boom");
    });
    expect(await captureRegisteredViewport3DThumbnail()).toBe(thumbnail);
    second();
    first();
    expect(await captureRegisteredViewport3DThumbnail()).toBeNull();
  });

  it("does not unregister a newer capture for the same slot", async () => {
    const stale = registerViewport3DThumbnailCapture("a", async () => null);
    const current = registerViewport3DThumbnailCapture("a", async () => thumbnail);
    stale();
    expect(await captureRegisteredViewport3DThumbnail()).toBe(thumbnail);
    current();
    expect(await captureRegisteredViewport3DThumbnail()).toBeNull();
  });
});
