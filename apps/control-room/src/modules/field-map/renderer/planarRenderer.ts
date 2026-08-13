export interface PlanarRenderer {
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
  layers?: { contours: boolean; mesh: boolean; vectors: boolean };
  meshBounds?: readonly [number, number, number, number];
  meshSegments?: Float32Array;
  meshViewport?: readonly [number, number, number, number];
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

  if (layers.layers?.mesh !== false && layers.meshSegments) {
    const bounds = layers.meshViewport ?? layers.meshBounds ?? [0, canvasWidth, 0, canvasHeight];
    const mapMesh = (u: number, v: number) => [
      ((u - bounds[0]) / (bounds[1] - bounds[0])) * canvasWidth,
      canvasHeight -
        ((v - bounds[2]) / (bounds[3] - bounds[2])) * canvasHeight,
    ];
    context.beginPath();
    for (let index = 0; index < layers.meshSegments.length; index += 4) {
      const start = mapMesh(
        layers.meshSegments[index] ?? 0,
        layers.meshSegments[index + 1] ?? 0,
      );
      const end = mapMesh(
        layers.meshSegments[index + 2] ?? 0,
        layers.meshSegments[index + 3] ?? 0,
      );
      context.moveTo(start[0]!, start[1]!);
      context.lineTo(end[0]!, end[1]!);
    }
    context.stroke();
  }

  if (layers.layers?.contours !== false && layers.contours?.length) {
    const gridHeight = layers.gridHeight ?? layers.gridWidth;
    const viewport = layers.viewport ?? [0, layers.gridWidth - 1, 0, gridHeight - 1];
    const mapX = (value: number) =>
      ((value - viewport[0]) / Math.max(1e-12, viewport[1] - viewport[0])) * canvasWidth;
    const mapY = (value: number) =>
      ((value - viewport[2]) / Math.max(1e-12, viewport[3] - viewport[2])) * canvasHeight;
    context.beginPath();
    for (const [x0, y0, x1, y1] of layers.contours) {
      context.moveTo(mapX(x0), mapY(y0));
      context.lineTo(mapX(x1), mapY(y1));
    }
    context.stroke();
  }

  if (layers.layers?.vectors !== false && layers.glyphs?.length) {
    context.beginPath();
    for (const glyph of layers.glyphs) {
      const x = glyph.index % layers.gridWidth;
      const y = Math.floor(glyph.index / layers.gridWidth);
      const gridHeight = layers.gridHeight ?? layers.gridWidth;
      const viewport = layers.viewport ?? [0, layers.gridWidth, 0, gridHeight];
      const scaleX = canvasWidth / Math.max(1e-12, viewport[1] - viewport[0]);
      const scaleY = canvasHeight / Math.max(1e-12, viewport[3] - viewport[2]);
      const originX = (x + 0.5 - viewport[0]) * scaleX;
      const originY = (y + 0.5 - viewport[2]) * scaleY;
      context.moveTo(originX, originY);
      context.lineTo(
        (x + 0.5 + glyph.u - viewport[0]) * scaleX,
        (y + 0.5 - glyph.v - viewport[2]) * scaleY,
      );
      if (Math.abs(glyph.normal) > 1e-15) {
        const normalDirection = glyph.normal < 0 ? -1 : 1;
        context.moveTo(originX, originY);
        context.lineTo(originX + normalDirection * 0.25 * scaleX, originY);
      }
    }
    context.stroke();
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
    const sourceY = ((vMax - viewVMax) / (vMax - vMin)) * lastImage.height;
    const sourceWidth = ((viewUMax - viewUMin) / (uMax - uMin)) * lastImage.width;
    const sourceHeight = ((viewVMax - viewVMin) / (vMax - vMin)) * lastImage.height;
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
  };
  return {
    dispose() {
      context.clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = 0;
      canvas.height = 0;
      if (scratch) {
        scratch.width = 0;
        scratch.height = 0;
      }
      scratch = null;
      lastImage = null;
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
      canvas.width = Math.max(1, Math.round(width * Math.min(dpr, 2)));
      canvas.height = Math.max(1, Math.round(height * Math.min(dpr, 2)));
      paint();
    },
  };
}
