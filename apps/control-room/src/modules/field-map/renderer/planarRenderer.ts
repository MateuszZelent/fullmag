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
  layers?: { boundaries?: boolean; bounds?: boolean; contours: boolean; mesh: boolean; points?: boolean; vectors: boolean };
  meshBounds?: readonly [number, number, number, number];
  meshSegments?: Float32Array;
  meshViewport?: readonly [number, number, number, number];
  samplePoints?: readonly { index: number; u: number; v: number }[];
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
  context.strokeStyle = "currentColor";
  context.lineWidth = 1;

  const bounds = layers.meshViewport ?? layers.meshBounds ?? [0, canvasWidth, 0, canvasHeight];
  const mapMesh = (u: number, v: number) => [
    ((u - bounds[0]) / (bounds[1] - bounds[0])) * canvasWidth,
    canvasHeight - ((v - bounds[2]) / (bounds[3] - bounds[2])) * canvasHeight,
  ];
  const drawMeshSegments = (segments: Float32Array, strokeStyle: string) => {
    context.strokeStyle = strokeStyle;
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
    drawMeshSegments(layers.meshSegments, "currentColor");
  }
  if (layers.layers?.boundaries && layers.boundarySegments) {
    drawMeshSegments(layers.boundarySegments, "var(--fm-accent)");
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
    context.strokeStyle = "var(--fm-info)";
    context.beginPath();
    context.moveTo(corners[0]![0]!, corners[0]![1]!);
    for (const corner of corners.slice(1)) context.lineTo(corner[0]!, corner[1]!);
    context.stroke();
  }
  if (layers.layers?.points && layers.samplePoints?.length) {
    context.fillStyle = "var(--fm-accent)";
    context.beginPath();
    for (const point of layers.samplePoints) {
      const [x, y] = mapMesh(point.u, point.v);
      context.moveTo(x + 1.5, y);
      context.arc(x, y, 1.5, 0, Math.PI * 2);
    }
    context.fill();
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

  if (layers.layers?.vectors !== false && layers.glyphs?.length) {
    for (const glyph of layers.glyphs) {
      context.beginPath();
      context.strokeStyle = vectorGlyphStrokeStyle(glyph, layers.vectorColorMode);
      const x = glyph.index % layers.gridWidth;
      const y = Math.floor(glyph.index / layers.gridWidth);
      const gridHeight = layers.gridHeight ?? layers.gridWidth;
      const viewport = layers.viewport ?? [0, layers.gridWidth, 0, gridHeight];
      const scaleX = canvasWidth / Math.max(1e-12, viewport[1] - viewport[0]);
      const scaleY = canvasHeight / Math.max(1e-12, viewport[3] - viewport[2]);
      const originX = (x + 0.5 - viewport[0]) * scaleX;
      const originY = canvasHeight - (y + 0.5 - viewport[2]) * scaleY;
      context.moveTo(originX, originY);
      context.lineTo(
        (x + 0.5 + glyph.u - viewport[0]) * scaleX,
        canvasHeight - (y + 0.5 + glyph.v - viewport[2]) * scaleY,
      );
      if (Math.abs(glyph.normal) > 1e-15) {
        const normalDirection = glyph.normal < 0 ? -1 : 1;
        context.moveTo(originX, originY);
        context.lineTo(originX + normalDirection * 0.25 * scaleX, originY);
      }
      context.stroke();
    }
  }
  context.restore();
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

function vectorGlyphStrokeStyle(
  glyph: { normal: number; u: number; v: number },
  colorMode: string | undefined,
): string {
  if (colorMode === "orientation") {
    const hue = Math.round(((Math.atan2(glyph.v, glyph.u) * 180) / Math.PI + 360) % 360);
    return `hsl(${hue} 80% 60%)`;
  }
  if (colorMode === "normal") return glyph.normal < 0 ? "var(--fm-danger)" : "var(--fm-info)";
  return "currentColor";
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
      const image = new ImageData(pixels, width, height);
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
