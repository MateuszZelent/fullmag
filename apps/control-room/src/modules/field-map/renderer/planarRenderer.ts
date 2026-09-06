import { isRenderablePlanarOccupancy } from "../model/planarOccupancy";
import type { FdmCellLayerInput } from "./fdmCellLayer";
import type { FemCutSurfaceInput } from "./femCutSurfaceLayer";
import { createPlanarGpuRenderer } from "./planarGpuRenderer";

export interface PlanarRenderer {
  clearBase(): void;
  dispose(): void;
  draw(pixels: Uint8ClampedArray, width: number, height: number): void;
  drawFemCutSurface?(input: FemCutSurfaceInput): void;
  drawFdmCells?(input: FdmCellLayerInput): void;
  getRendererKind(): "gpu" | "canvas2d";
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
  glyphs?: readonly {
    index: number;
    normal: number;
    u: number;
    v: number;
  }[];
  gridWidth: number;
  gridHeight?: number;
  boundarySegments?: Float32Array;
  boundsOutline?: readonly [number, number, number, number] | null;
  interiorSegments?: Float32Array;
  layers?: { boundaries?: boolean; bounds?: boolean; contours: boolean; mesh: boolean; points?: boolean; vectors: boolean };
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
): void {
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
    const meshToDraw =
      layers.layers?.boundaries && layers.boundarySegments && layers.boundarySegments.length > 0 && layers.interiorSegments
        ? layers.interiorSegments
        : layers.meshSegments;
    drawMeshSegments(meshToDraw, layers.wireframeStyle?.color ?? "currentColor");
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
    const viewport = layers.viewport ?? [0, layers.gridWidth, 0, gridHeight];
    const mapX = (value: number) =>
      ((value + 0.5 - viewport[0]) / Math.max(1e-12, viewport[1] - viewport[0])) * canvasWidth;
    const mapY = (value: number) =>
      canvasHeight - ((value + 0.5 - viewport[2]) / Math.max(1e-12, viewport[3] - viewport[2])) * canvasHeight;
    context.beginPath();
    for (const [x0, y0, x1, y1] of layers.contours) {
      context.moveTo(mapX(x0), mapY(y0));
      context.lineTo(mapX(x1), mapY(y1));
    }
    context.stroke();
  }

  if (layers.layers?.vectors !== false && layers.glyphs?.length) {
    context.globalAlpha = layers.vectorStyle?.opacity ?? 1;
    context.lineWidth = layers.vectorStyle?.thickness ?? 1;
    for (const glyph of layers.glyphs) {
      context.beginPath();
      setCanvasStrokeStyle(context, layers.vectorColorMode === "monochrome"
        ? layers.vectorStyle?.color ?? "currentColor"
        : vectorGlyphStrokeStyle(glyph, layers.vectorColorMode));
      const x = glyph.index % layers.gridWidth;
      const y = Math.floor(glyph.index / layers.gridWidth);
      const gridHeight = layers.gridHeight ?? layers.gridWidth;
      const viewport = layers.viewport ?? [0, layers.gridWidth, 0, gridHeight];
      const scaleX = canvasWidth / Math.max(1e-12, viewport[1] - viewport[0]);
      const scaleY = canvasHeight / Math.max(1e-12, viewport[3] - viewport[2]);
      const originX = (x + 0.5 - viewport[0]) * scaleX;
      const originY = canvasHeight - (y + 0.5 - viewport[2]) * scaleY;
      const endX = (x + 0.5 + glyph.u - viewport[0]) * scaleX;
      const endY = canvasHeight - (y + 0.5 + glyph.v - viewport[2]) * scaleY;
      const dx = endX - originX;
      const dy = endY - originY;
      const inPlaneLengthPx = Math.hypot(dx, dy);

      if (inPlaneLengthPx > 2) {
        context.moveTo(originX, originY);
        context.lineTo(endX, endY);

        const headLength = Math.min(8, Math.max(3, inPlaneLengthPx * 0.3));
        const angle = Math.atan2(dy, dx);
        const barbAngle = Math.PI / 6;
        context.moveTo(endX, endY);
        context.lineTo(
          endX - headLength * Math.cos(angle - barbAngle),
          endY - headLength * Math.sin(angle - barbAngle),
        );
        context.moveTo(endX, endY);
        context.lineTo(
          endX - headLength * Math.cos(angle + barbAngle),
          endY - headLength * Math.sin(angle + barbAngle),
        );
      } else if (Math.abs(glyph.normal) > 1e-15) {
        const radius = Math.max(2.5, Math.min(5, 3 * (layers.vectorStyle?.thickness ?? 1)));
        context.arc(originX, originY, radius, 0, Math.PI * 2);
        if (glyph.normal > 0) {
          context.moveTo(originX + radius * 0.3, originY);
          context.arc(originX, originY, radius * 0.3, 0, Math.PI * 2);
        } else {
          const d = radius * 0.707;
          context.moveTo(originX - d, originY - d);
          context.lineTo(originX + d, originY + d);
          context.moveTo(originX - d, originY + d);
          context.lineTo(originX + d, originY - d);
        }
      }
      context.stroke();
    }
    context.globalAlpha = 1;
    context.lineWidth = 1;
  }
  context.restore();
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
}): { boundarySegments: Float32Array; interiorSegments: Float32Array; meshSegments: Float32Array } {
  if (overlay.boundaryClassification === "unavailable") {
    return {
      boundarySegments: new Float32Array(),
      interiorSegments: overlay.segments,
      meshSegments: overlay.segments,
    };
  }

  let boundaryCount = 0;
  let interiorCount = 0;
  for (let index = 0; index < overlay.segmentKinds.length; index += 1) {
    if (overlay.segmentKinds[index] === 1) {
      boundaryCount += 1;
    } else {
      interiorCount += 1;
    }
  }

  const boundary = new Float32Array(boundaryCount * 4);
  const interior = new Float32Array(interiorCount * 4);
  let bOffset = 0;
  let iOffset = 0;

  for (let index = 0; index < overlay.segmentKinds.length; index += 1) {
    const chunk = overlay.segments.subarray(index * 4, index * 4 + 4);
    if (overlay.segmentKinds[index] === 1) {
      boundary.set(chunk, bOffset);
      bOffset += 4;
    } else {
      interior.set(chunk, iOffset);
      iOffset += 4;
    }
  }

  return {
    boundarySegments: boundary,
    interiorSegments: interior,
    meshSegments: overlay.segments,
  };
}

export function extractFdmOccupancyBoundaries(
  mask: Uint8Array | ArrayLike<number>,
  bounds: readonly [number, number, number, number],
  resolution: readonly [number, number],
): Float32Array {
  const [width, height] = resolution;
  const [uMin, uMax, vMin, vMax] = bounds;
  const du = (uMax - uMin) / Math.max(1, width);
  const dv = (vMax - vMin) / Math.max(1, height);

  const isOcc = (x: number, y: number): boolean => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    const val = mask[y * width + x];
    return isRenderablePlanarOccupancy(val);
  };

  const segments: number[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isOcc(x, y)) continue;

      const x0 = uMin + x * du;
      const x1 = uMin + (x + 1) * du;
      const y0 = vMin + y * dv;
      const y1 = vMin + (y + 1) * dv;

      // Bottom edge
      if (!isOcc(x, y - 1)) {
        segments.push(x0, y0, x1, y0);
      }
      // Top edge
      if (!isOcc(x, y + 1)) {
        segments.push(x0, y1, x1, y1);
      }
      // Left edge
      if (!isOcc(x - 1, y)) {
        segments.push(x0, y0, x0, y1);
      }
      // Right edge
      if (!isOcc(x + 1, y)) {
        segments.push(x1, y0, x1, y1);
      }
    }
  }

  return new Float32Array(segments);
}

function vectorGlyphStrokeStyle(
  glyph: { normal: number; u: number; v: number; origNormal?: number; origU?: number; origV?: number },
  colorMode: string | undefined,
): string {
  if (colorMode === "orientation") {
    const u = glyph.origU ?? glyph.u;
    const v = glyph.origV ?? glyph.v;
    const hue = Math.round(((Math.atan2(v, u) * 180) / Math.PI + 360) % 360);
    return `hsl(${hue} 80% 60%)`;
  }
  if (colorMode === "normal") {
    const normal = glyph.origNormal ?? glyph.normal;
    return normal < 0 ? "var(--fm-danger)" : "var(--fm-info)";
  }
  if (colorMode === "magnitude") {
    const u = glyph.origU ?? glyph.u;
    const v = glyph.origV ?? glyph.v;
    const normal = glyph.origNormal ?? glyph.normal;
    const mag = Math.hypot(u, v, normal);
    const hue = Math.round(Math.min(280, Math.max(0, 240 - Math.min(1, mag) * 200)));
    return `hsl(${hue} 85% 55%)`;
  }
  return "currentColor";
}

export function createPlanar2dRenderer(
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
      const image = new ImageData(pixels, width, height);
      scratch.width = width;
      scratch.height = height;
      scratch.getContext("2d")?.putImageData(image, 0, 0);
      lastImage = { height, width };
      paint();
    },
    getRendererKind: () => "canvas2d",
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

export { WebGLContextTaintedError } from "./planarGpuRenderer";

export function createPlanarRenderer(
  canvas: HTMLCanvasElement,
  options?: { preferGpu?: boolean },
): PlanarRenderer {
  if (options?.preferGpu !== false) {
    const gpuRenderer = createPlanarGpuRenderer(canvas);
    if (gpuRenderer) return gpuRenderer;
  }
  return createPlanar2dRenderer(canvas);
}
