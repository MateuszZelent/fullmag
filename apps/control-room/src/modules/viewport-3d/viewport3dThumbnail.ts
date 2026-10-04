import {
  surfaceColorSourceToColorMode,
  type VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";
import { bytesToBase64 } from "@/kernel/persistence/ProjectDocumentController";

import { isDivergingScalarPalette } from "../../shared/visualization/scalarColorPalette";
import {
  normalizeViewport3DColorPalette,
  normalizeViewport3DVectorColorMode,
} from "./viewport3dVectorColoring";

export type Viewport3DThumbnailColouring =
  | "hsl-sphere"
  | "mz-diverging"
  | "scalar-viridis"
  | "none";

export interface Viewport3DThumbnail {
  readonly colouring: Viewport3DThumbnailColouring;
  readonly height: number;
  readonly pngBase64: string;
  readonly width: number;
}

/** The host stores the thumbnail in the project file and refuses larger ones. */
export const VIEWPORT_3D_THUMBNAIL_MAX_BYTES = 250_000;

export const VIEWPORT_3D_THUMBNAIL_SIZES: ReadonlyArray<
  Readonly<{ height: number; width: number }>
> = [
  { height: 200, width: 320 },
  { height: 160, width: 256 },
  { height: 120, width: 192 },
  { height: 100, width: 160 },
  { height: 80, width: 128 },
];

const THUMBNAIL_ASPECT = 16 / 10;

export interface Viewport3DThumbnailCrop {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

/** The centred 16:10 window of a source of the given size. */
export function viewport3DThumbnailCrop(
  sourceWidth: number,
  sourceHeight: number,
): Viewport3DThumbnailCrop | null {
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    sourceWidth < 1 ||
    sourceHeight < 1
  ) {
    return null;
  }
  const width = Math.floor(sourceWidth);
  const height = Math.floor(sourceHeight);
  const cropWidth = Math.max(1, Math.min(width, Math.floor(height * THUMBNAIL_ASPECT)));
  const cropHeight = Math.max(1, Math.min(height, Math.floor(cropWidth / THUMBNAIL_ASPECT)));
  return {
    height: cropHeight,
    width: cropWidth,
    x: Math.floor((width - cropWidth) / 2),
    y: Math.floor((height - cropHeight) / 2),
  };
}

type ThumbnailColouringSettings = Pick<
  VisualizationTargetSettings,
  | "activeQuantityId"
  | "scalarColorPalette"
  | "shaderVisible"
  | "surfaceColorSource"
  | "vectorColorMode"
  | "vectorsVisible"
>;

function isMagnetizationQuantity(quantityId: string): boolean {
  return quantityId === "m" || quantityId.startsWith("m_");
}

/**
 * Names the mapping the viewport is using so a thumbnail is never read under
 * another one. A mapping the host cannot name stays `none`: a palette other than
 * viridis is not relabelled as viridis.
 */
export function resolveViewport3DThumbnailColouring(
  settings: ThumbnailColouringSettings,
): Viewport3DThumbnailColouring {
  const surfaceMode = settings.shaderVisible
    ? surfaceColorSourceToColorMode(settings.surfaceColorSource)
    : null;
  const mode = surfaceMode ?? (settings.vectorsVisible ? settings.vectorColorMode : null);
  if (!mode) return "none";
  const normalized = normalizeViewport3DVectorColorMode(mode, "monochrome");
  if (normalized === "orientation") return "hsl-sphere";
  if (normalized === "monochrome") return "none";
  const palette = normalizeViewport3DColorPalette(settings.scalarColorPalette, "viridis");
  if (
    normalized === "z" &&
    isMagnetizationQuantity(settings.activeQuantityId) &&
    isDivergingScalarPalette(palette)
  ) {
    return "mz-diverging";
  }
  return palette === "viridis" ? "scalar-viridis" : "none";
}

/** A frame whose pixels are all identical is a cleared or lost buffer, not a render. */
export function isBlankThumbnailFrame(data: ArrayLike<number>): boolean {
  if (data.length < 4) return true;
  const r = data[0];
  const g = data[1];
  const b = data[2];
  const a = data[3];
  if (a === 0) {
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] !== 0) return false;
    }
    return true;
  }
  for (let index = 4; index + 3 < data.length; index += 4) {
    if (
      data[index] !== r ||
      data[index + 1] !== g ||
      data[index + 2] !== b ||
      data[index + 3] !== a
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Walks the size ladder from the largest and returns the first encoding within
 * the budget. PNG has no quality knob, so smaller dimensions are the only lever.
 */
export async function fitThumbnailToBudget<T extends { readonly size: number }>(
  encode: (size: { readonly height: number; readonly width: number }) => Promise<T | null>,
  maxBytes: number = VIEWPORT_3D_THUMBNAIL_MAX_BYTES,
  sizes: typeof VIEWPORT_3D_THUMBNAIL_SIZES = VIEWPORT_3D_THUMBNAIL_SIZES,
): Promise<(T & { readonly height: number; readonly width: number }) | null> {
  for (const size of sizes) {
    const encoded = await encode(size);
    if (encoded && encoded.size > 0 && encoded.size <= maxBytes) {
      return { ...encoded, height: size.height, width: size.width };
    }
  }
  return null;
}

export interface CaptureViewport3DThumbnailOptions {
  readonly canvas: HTMLCanvasElement | null | undefined;
  readonly colouring: Viewport3DThumbnailColouring;
  readonly createCanvas?: () => HTMLCanvasElement;
  readonly maxBytes?: number;
  /** Renders the scene into `canvas` so its buffer is valid for this task. */
  readonly render?: () => void;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), "image/png");
    } catch {
      resolve(null);
    }
  });
}

/**
 * Copies the centred 16:10 window of the live WebGL canvas into an offscreen
 * canvas and encodes it. The renderer does not preserve its drawing buffer, so
 * the scene is rendered and copied in the same synchronous step before anything
 * is awaited. Resolves `null` instead of throwing when there is nothing
 * trustworthy to store: no canvas, zero size, a lost context or a blank frame.
 */
export async function captureViewport3DThumbnail({
  canvas,
  colouring,
  createCanvas = () => document.createElement("canvas"),
  maxBytes = VIEWPORT_3D_THUMBNAIL_MAX_BYTES,
  render,
}: CaptureViewport3DThumbnailOptions): Promise<Viewport3DThumbnail | null> {
  if (!canvas) return null;
  let master: HTMLCanvasElement;
  try {
    const gl =
      (canvas.getContext("webgl2") as WebGL2RenderingContext | null) ??
      (canvas.getContext("webgl") as WebGLRenderingContext | null);
    if (gl?.isContextLost()) return null;
    const sourceWidth = gl?.drawingBufferWidth ?? canvas.width;
    const sourceHeight = gl?.drawingBufferHeight ?? canvas.height;
    const crop = viewport3DThumbnailCrop(sourceWidth, sourceHeight);
    if (!crop) return null;

    render?.();

    const largest = VIEWPORT_3D_THUMBNAIL_SIZES[0];
    master = createCanvas();
    master.width = largest.width;
    master.height = largest.height;
    const context = master.getContext("2d");
    if (!context) return null;
    context.drawImage(
      canvas,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      largest.width,
      largest.height,
    );
    if (isBlankThumbnailFrame(context.getImageData(0, 0, largest.width, largest.height).data)) {
      return null;
    }
  } catch {
    return null;
  }

  const fitted = await fitThumbnailToBudget(async (size) => {
    let target = master;
    if (size.width !== master.width || size.height !== master.height) {
      target = createCanvas();
      target.width = size.width;
      target.height = size.height;
      const context = target.getContext("2d");
      if (!context) return null;
      context.drawImage(master, 0, 0, master.width, master.height, 0, 0, size.width, size.height);
    }
    const blob = await canvasToBlob(target);
    return blob ? { blob, size: blob.size } : null;
  }, maxBytes);
  if (!fitted) return null;

  try {
    const bytes = new Uint8Array(await fitted.blob.arrayBuffer());
    return {
      colouring,
      height: fitted.height,
      pngBase64: bytesToBase64(bytes),
      width: fitted.width,
    };
  } catch {
    return null;
  }
}
