import { directionHslSrgb } from "@/shared/visualization/directionColor";
import { scalarColorSrgb } from "@/shared/visualization/scalarColorPalette";

import type { PlanarStreamlines } from "./planarStreamlines";
import { glyphSpacingForBudget, layoutScreenGlyphs, type ScreenGlyph } from "./vectorGlyphs";

export interface PlanarRenderer {
  clearBase(): void;
  dispose(): void;
  draw(pixels: Uint8ClampedArray, width: number, height: number): void;
  resolveViewport(
    bounds: readonly [number, number, number, number],
    interaction: { panU: number; panV: number; zoom: number },
  ): readonly [number, number, number, number];
  setViewport(
    bounds: readonly [number, number, number, number],
    viewport: readonly [number, number, number, number],
  ): void;
  resize(width: number, height: number, dpr: number): void;
}

export interface PlanarOverlayLayers {
  axisPointer?: { u: number; v: number } | null;
  contours?: readonly (readonly [number, number, number, number])[];
  /** Frame-projected vectors (u, v, normal per raster cell) for the quiver layer. */
  vectorField?: {
    values: ArrayLike<number>;
    budget: number;
    lengthMode: string;
    mask?: ArrayLike<number> | null;
    scale: number;
    /** Physical sample bounds [uMin, uMax, vMin, vMax]. */
    sampleBounds: readonly [number, number, number, number];
  } | null;
  /** In-plane streamlines in physical (u, v); drawn under the quiver. */
  streamlines?: PlanarStreamlines | null;
  gridWidth: number;
  gridHeight?: number;
  boundarySegments?: Float32Array;
  boundsOutline?: readonly [number, number, number, number] | null;
  layers?: { boundaries?: boolean; bounds?: boolean; contours: boolean; mesh: boolean; points?: boolean; streamlines?: boolean; vectors: boolean };
  meshBounds?: readonly [number, number, number, number];
  meshSegments?: Float32Array;
  meshViewport?: readonly [number, number, number, number];
  samplePoints?: readonly { index: number; u: number; v: number }[];
  pointStyle?: { color: string; opacity: number; size: number };
  wireframeStyle?: { color: string; opacity: number };
  vectorStyle?: { color: string; opacity: number; thickness: number };
  vectorColorMode?: string;
  viewport?: readonly [number, number, number, number];
}

export function drawPlanarOverlays(
  context: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  layers: PlanarOverlayLayers,
): { glyphCount: number } {
  let glyphCount = 0;
  context.clearRect(0, 0, canvasWidth, canvasHeight);
  context.save();
  setCanvasStrokeStyle(context, "currentColor");
  context.lineWidth = 1;

  const bounds = layers.meshViewport ?? layers.meshBounds ?? [0, canvasWidth, 0, canvasHeight];
  const mapMesh = (u: number, v: number) => [
    ((u - bounds[0]) / (bounds[1] - bounds[0])) * canvasWidth,
    canvasHeight - ((v - bounds[2]) / (bounds[3] - bounds[2])) * canvasHeight,
  ];
  const drawMeshSegments = (segments: Float32Array, strokeStyle: string) => {
    setCanvasStrokeStyle(context, strokeStyle);
    context.beginPath();
    for (let index = 0; index < segments.length; index += 4) {
      const start = mapMesh(segments[index] ?? 0, segments[index + 1] ?? 0);
      const end = mapMesh(segments[index + 2] ?? 0, segments[index + 3] ?? 0);
      context.moveTo(start[0]!, start[1]!);
      context.lineTo(end[0]!, end[1]!);
    }
    context.stroke();
  };

  if (layers.layers?.mesh !== false && layers.meshSegments) {
    context.globalAlpha = layers.wireframeStyle?.opacity ?? 1;
    drawMeshSegments(layers.meshSegments, layers.wireframeStyle?.color ?? "currentColor");
    context.globalAlpha = 1;
  }
  if (layers.layers?.boundaries && layers.boundarySegments) {
    context.globalAlpha = layers.wireframeStyle?.opacity ?? 1;
    drawMeshSegments(layers.boundarySegments, layers.wireframeStyle?.color ?? "var(--fm-accent)");
    context.globalAlpha = 1;
  }
  if (layers.layers?.bounds && layers.boundsOutline) {
    const [uMin, uMax, vMin, vMax] = layers.boundsOutline;
    const corners = [
      mapMesh(uMin, vMin),
      mapMesh(uMax, vMin),
      mapMesh(uMax, vMax),
      mapMesh(uMin, vMax),
      mapMesh(uMin, vMin),
    ];
    setCanvasStrokeStyle(context, "var(--fm-info)");
    context.beginPath();
    context.moveTo(corners[0]![0]!, corners[0]![1]!);
    for (const corner of corners.slice(1)) context.lineTo(corner[0]!, corner[1]!);
    context.stroke();
  }
  if (layers.layers?.points && layers.samplePoints?.length) {
    setCanvasFillStyle(context, layers.pointStyle?.color ?? "var(--fm-accent)");
    context.globalAlpha = layers.pointStyle?.opacity ?? 1;
    const radius = Math.max(0.25, (layers.pointStyle?.size ?? 3) / 2);
    context.beginPath();
    for (const point of layers.samplePoints) {
      const [x, y] = mapMesh(point.u, point.v);
      context.moveTo(x + radius, y);
      context.arc(x, y, radius, 0, Math.PI * 2);
    }
    context.fill();
    context.globalAlpha = 1;
  }

  if (layers.axisPointer) {
    const [x, y] = mapMesh(layers.axisPointer.u, layers.axisPointer.v);
    setCanvasStrokeStyle(context, "var(--fm-accent)");
    context.lineWidth = 2;
    context.setLineDash([6, 4]);
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, canvasHeight);
    context.moveTo(0, y);
    context.lineTo(canvasWidth, y);
    context.stroke();
    context.setLineDash([]);
    context.lineWidth = 1;
  }

  if (layers.layers?.contours !== false && layers.contours?.length) {
    const gridHeight = layers.gridHeight ?? layers.gridWidth;
    const viewport = layers.viewport ?? [0, layers.gridWidth - 1, 0, gridHeight - 1];
    const mapX = (value: number) =>
      ((value - viewport[0]) / Math.max(1e-12, viewport[1] - viewport[0])) * canvasWidth;
    const mapY = (value: number) =>
      canvasHeight - ((value - viewport[2]) / Math.max(1e-12, viewport[3] - viewport[2])) * canvasHeight;
    context.beginPath();
    for (const [x0, y0, x1, y1] of layers.contours) {
      context.moveTo(mapX(x0), mapY(y0));
      context.lineTo(mapX(x1), mapY(y1));
    }
    context.stroke();
  }

  if (layers.layers?.streamlines && layers.streamlines && layers.meshViewport) {
    drawStreamlines(context, layers.streamlines, layers.meshViewport, canvasWidth, canvasHeight, layers.vectorColorMode, layers.vectorStyle);
  }
  if (layers.layers?.vectors !== false && layers.vectorField && layers.meshViewport) {
    const field = layers.vectorField;
    const glyphs = layoutScreenGlyphs({
      bounds: field.sampleBounds,
      canvasHeight,
      canvasWidth,
      gridHeight: layers.gridHeight ?? layers.gridWidth,
      gridWidth: layers.gridWidth,
      lengthMode: field.lengthMode,
      mask: field.mask,
      scale: field.scale,
      spacingPx: glyphSpacingForBudget(canvasWidth, canvasHeight, field.budget),
      vectors: field.values,
      viewport: layers.meshViewport,
    });
    drawScreenGlyphs(context, glyphs, layers.vectorColorMode, layers.vectorStyle);
    glyphCount = glyphs.length;
  }
  context.restore();
  return { glyphCount };
}

function resolveCanvasTokenColor(
  context: CanvasRenderingContext2D,
  token: string,
): string | null {
  const canvas = context.canvas;
  const view = canvas?.ownerDocument?.defaultView;
  if (!view) return null;
  const value = view.getComputedStyle(canvas).getPropertyValue(token).trim();
  return value || null;
}

function resolveCanvasPaintColor(
  context: CanvasRenderingContext2D,
  color: string,
): string {
  const normalized = color.trim();
  const token = normalized === "currentColor"
    ? "color"
    : /^var\((--[\w-]+)\)$/.exec(normalized)?.[1];
  return token ? resolveCanvasTokenColor(context, token) ?? normalized : normalized;
}

function setCanvasStrokeStyle(
  context: CanvasRenderingContext2D,
  color: string,
): void {
  context.strokeStyle = resolveCanvasPaintColor(context, color);
}

function setCanvasFillStyle(
  context: CanvasRenderingContext2D,
  color: string,
): void {
  context.fillStyle = resolveCanvasPaintColor(context, color);
}

export function partitionPlanarMeshSegments(overlay: {
  boundaryClassification: "degraded" | "exact" | "unavailable";
  segmentKinds: Uint8Array;
  segments: Float32Array;
}): { boundarySegments: Float32Array; meshSegments: Float32Array } {
  if (overlay.boundaryClassification !== "exact") {
    return { boundarySegments: new Float32Array(), meshSegments: overlay.segments };
  }
  const boundary = new Float32Array(overlay.segmentKinds.reduce(
    (count, kind) => count + (kind === 1 ? 4 : 0),
    0,
  ));
  let offset = 0;
  for (let index = 0; index < overlay.segmentKinds.length; index += 1) {
    if (overlay.segmentKinds[index] !== 1) continue;
    boundary.set(overlay.segments.subarray(index * 4, index * 4 + 4), offset);
    offset += 4;
  }
  return { boundarySegments: boundary, meshSegments: overlay.segments };
}

/** Dark halo under each glyph keeps coloured arrows readable over the raster. */
const GLYPH_HALO = "rgba(17, 17, 27, 0.55)";
/** mumax3 draws dark arrows over its direction image; a light halo separates them. */
const GLYPH_CONTRAST = "rgba(17, 17, 27, 0.9)";
const GLYPH_CONTRAST_HALO = "rgba(255, 255, 255, 0.7)";

function glyphColor(
  glyph: ScreenGlyph,
  colorMode: string | undefined,
  monochrome: string,
): string {
  if (colorMode === "orientation") {
    const [red, green, blue] = directionHslSrgb(glyph.u, glyph.v, glyph.normal);
    return `rgb(${Math.round(red * 255)} ${Math.round(green * 255)} ${Math.round(blue * 255)})`;
  }
  if (colorMode === "contrast") return GLYPH_CONTRAST;
  if (colorMode === "magnitude") {
    const [red, green, blue] = scalarColorSrgb(glyph.magnitudeRatio, "viridis");
    return `rgb(${Math.round(red * 255)} ${Math.round(green * 255)} ${Math.round(blue * 255)})`;
  }
  return monochrome;
}

/**
 * Streamlines as polylines with one chevron at the middle of each line to show
 * the sense of the in-plane projection. Monochrome; dark over a direction image.
 */
function drawStreamlines(
  context: CanvasRenderingContext2D,
  lines: PlanarStreamlines,
  viewport: readonly [number, number, number, number],
  canvasWidth: number,
  canvasHeight: number,
  colorMode: string | undefined,
  style: PlanarOverlayLayers["vectorStyle"],
) {
  const viewU = viewport[1] - viewport[0];
  const viewV = viewport[3] - viewport[2];
  if (lines.lineCount === 0 || !(viewU > 0) || !(viewV > 0)) return;
  const x = (u: number) => ((u - viewport[0]) / viewU) * canvasWidth;
  const y = (v: number) => canvasHeight - ((v - viewport[2]) / viewV) * canvasHeight;
  const lineWidth = Math.max(1, style?.thickness ?? 1);
  const contrast = colorMode === "contrast";
  const color = contrast ? GLYPH_CONTRAST : resolveCanvasPaintColor(context, style?.color ?? "currentColor");
  const { offsets, points } = lines;
  context.save();
  context.globalAlpha = style?.opacity ?? 1;
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const pass of ["halo", "line"] as const) {
    context.strokeStyle = pass === "halo" ? (contrast ? GLYPH_CONTRAST_HALO : GLYPH_HALO) : color;
    context.lineWidth = pass === "halo" ? lineWidth + 2 : lineWidth;
    context.beginPath();
    for (let line = 0; line < lines.lineCount; line += 1) {
      const start = offsets[line]!;
      const end = offsets[line + 1]!;
      context.moveTo(x(points[start * 2]!), y(points[start * 2 + 1]!));
      for (let index = start + 1; index < end; index += 1) {
        context.lineTo(x(points[index * 2]!), y(points[index * 2 + 1]!));
      }
      const middle = start + Math.floor((end - start) / 2);
      if (middle + 1 >= end) continue;
      const tipX = x(points[(middle + 1) * 2]!);
      const tipY = y(points[(middle + 1) * 2 + 1]!);
      const angle = Math.atan2(tipY - y(points[middle * 2 + 1]!), tipX - x(points[middle * 2]!));
      const head = 3 + 2 * lineWidth;
      context.moveTo(tipX - head * Math.cos(angle - 0.5), tipY - head * Math.sin(angle - 0.5));
      context.lineTo(tipX, tipY);
      context.lineTo(tipX - head * Math.cos(angle + 0.5), tipY - head * Math.sin(angle + 0.5));
    }
    context.stroke();
  }
  context.restore();
}

function traceArrow(context: CanvasRenderingContext2D, glyph: ScreenGlyph, lineWidth: number) {
  const half = glyph.length / 2;
  const cos = Math.cos(glyph.angle);
  const sin = Math.sin(glyph.angle);
  const tipX = glyph.x + cos * half;
  const tipY = glyph.y + sin * half;
  const headLength = Math.max(4 * lineWidth, 0.38 * glyph.length);
  const headHalfWidth = 0.55 * headLength / 2 + lineWidth / 2;
  const neckX = tipX - cos * headLength;
  const neckY = tipY - sin * headLength;
  context.moveTo(glyph.x - cos * half, glyph.y - sin * half);
  context.lineTo(neckX, neckY);
  context.moveTo(tipX, tipY);
  context.lineTo(neckX - sin * headHalfWidth, neckY + cos * headHalfWidth);
  context.lineTo(neckX + sin * headHalfWidth, neckY - cos * headHalfWidth);
  context.closePath();
}

function drawScreenGlyphs(
  context: CanvasRenderingContext2D,
  glyphs: readonly ScreenGlyph[],
  colorMode: string | undefined,
  style: PlanarOverlayLayers["vectorStyle"],
) {
  if (glyphs.length === 0) return;
  const lineWidth = Math.max(1, style?.thickness ?? 1) * 1.4;
  const monochrome = resolveCanvasPaintColor(context, style?.color ?? "currentColor");
  context.save();
  context.globalAlpha = style?.opacity ?? 1;
  context.lineCap = "round";
  context.lineJoin = "round";
  const halo = colorMode === "contrast" ? GLYPH_CONTRAST_HALO : GLYPH_HALO;
  for (const pass of ["halo", "glyph"] as const) {
    for (const glyph of glyphs) {
      const color = pass === "halo" ? halo : glyphColor(glyph, colorMode, monochrome);
      context.strokeStyle = color;
      context.fillStyle = color;
      context.lineWidth = pass === "halo" ? lineWidth + 2 : lineWidth;
      context.beginPath();
      if (glyph.kind === "arrow") {
        traceArrow(context, glyph, lineWidth);
        context.stroke();
        context.fill();
        continue;
      }
      const radius = 3 + lineWidth;
      context.arc(glyph.x, glyph.y, radius, 0, Math.PI * 2);
      context.stroke();
      context.beginPath();
      if (glyph.kind === "out-of-plane") {
        context.arc(glyph.x, glyph.y, Math.max(1, lineWidth * 0.9), 0, Math.PI * 2);
        context.fill();
      } else {
        const arm = radius * 0.7;
        context.moveTo(glyph.x - arm, glyph.y - arm);
        context.lineTo(glyph.x + arm, glyph.y + arm);
        context.moveTo(glyph.x + arm, glyph.y - arm);
        context.lineTo(glyph.x - arm, glyph.y + arm);
        context.stroke();
      }
    }
  }
  context.restore();
}

export function createPlanarRenderer(
  canvas: HTMLCanvasElement,
): PlanarRenderer {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas context unavailable");
  let scratch: HTMLCanvasElement | null = null;
  let lastImage: { height: number; width: number } | null = null;
  let view: {
    bounds: readonly [number, number, number, number];
    viewport: readonly [number, number, number, number];
  } | null = null;
  const paint = () => {
    if (!lastImage || !scratch) return;
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!view) {
      context.drawImage(scratch, 0, 0, canvas.width, canvas.height);
      return;
    }
    const [uMin, uMax, vMin, vMax] = view.bounds;
    const [viewUMin, viewUMax, viewVMin, viewVMax] = view.viewport;
    const sourceX = ((viewUMin - uMin) / (uMax - uMin)) * lastImage.width;
    const sourceY = ((viewVMin - vMin) / (vMax - vMin)) * lastImage.height;
    const sourceWidth = ((viewUMax - viewUMin) / (uMax - uMin)) * lastImage.width;
    const sourceHeight = ((viewVMax - viewVMin) / (vMax - vMin)) * lastImage.height;
    context.save();
    context.translate(0, canvas.height);
    context.scale(1, -1);
    context.drawImage(
      scratch,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    context.restore();
  };
  const clearBase = () => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (scratch) {
      scratch.width = 0;
      scratch.height = 0;
    }
    scratch = null;
    lastImage = null;
  };
  return {
    clearBase,
    dispose() {
      clearBase();
      canvas.width = 0;
      canvas.height = 0;
      view = null;
    },
    draw(pixels, width, height) {
      scratch ??= document.createElement("canvas");
      const imagePixels = pixels.buffer instanceof ArrayBuffer
        ? new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.length)
        : new Uint8ClampedArray(pixels);
      const image = new ImageData(imagePixels, width, height);
      scratch.width = width;
      scratch.height = height;
      scratch.getContext("2d")?.putImageData(image, 0, 0);
      lastImage = { height, width };
      paint();
    },
    resolveViewport(bounds, interaction) {
      const zoom = Math.max(1e-12, interaction.zoom);
      const centerU = (bounds[0] + bounds[1]) / 2 + interaction.panU;
      const centerV = (bounds[2] + bounds[3]) / 2 + interaction.panV;
      const halfU = (bounds[1] - bounds[0]) / (2 * zoom);
      const halfV = (bounds[3] - bounds[2]) / (2 * zoom);
      return [centerU - halfU, centerU + halfU, centerV - halfV, centerV + halfV];
    },
    setViewport(bounds, viewport) {
      view = { bounds, viewport };
      paint();
    },
    resize(width, height, dpr) {
      const pixelRatio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
      canvas.width = Math.max(1, Math.round(width * pixelRatio));
      canvas.height = Math.max(1, Math.round(height * pixelRatio));
      paint();
    },
  };
}
