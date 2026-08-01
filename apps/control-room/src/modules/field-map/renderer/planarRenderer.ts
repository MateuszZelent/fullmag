export interface PlanarRenderer {
  dispose(): void;
  draw(pixels: Uint8ClampedArray, width: number, height: number): void;
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
  meshBounds?: readonly [number, number, number, number];
  meshSegments?: Float32Array;
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

  if (layers.meshSegments) {
    const bounds = layers.meshBounds ?? [0, canvasWidth, 0, canvasHeight];
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

  if (layers.contours?.length) {
    const gridHeight = layers.gridHeight ?? layers.gridWidth;
    context.beginPath();
    for (const [x0, y0, x1, y1] of layers.contours) {
      context.moveTo(
        (x0 / Math.max(1, layers.gridWidth - 1)) * canvasWidth,
        (y0 / Math.max(1, gridHeight - 1)) * canvasHeight,
      );
      context.lineTo(
        (x1 / Math.max(1, layers.gridWidth - 1)) * canvasWidth,
        (y1 / Math.max(1, gridHeight - 1)) * canvasHeight,
      );
    }
    context.stroke();
  }

  if (layers.glyphs?.length) {
    context.beginPath();
    for (const glyph of layers.glyphs) {
      const x = glyph.index % layers.gridWidth;
      const y = Math.floor(glyph.index / layers.gridWidth);
      const scaleX = canvasWidth / Math.max(1, layers.gridWidth);
      const scaleY =
        canvasHeight / Math.max(1, layers.gridHeight ?? layers.gridWidth);
      context.moveTo((x + 0.5) * scaleX, (y + 0.5) * scaleY);
      context.lineTo(
        (x + 0.5 + glyph.u) * scaleX,
        (y + 0.5 - glyph.v) * scaleY,
      );
      if (Math.abs(glyph.normal) > 1e-15) {
        context.moveTo(x * scaleX, (y + 0.5) * scaleY);
        context.lineTo((x + 1) * scaleX, (y + 0.5) * scaleY);
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
  return {
    dispose() {
      context.clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = 0;
      canvas.height = 0;
    },
    draw(pixels, width, height) {
      const image = new ImageData(pixels, width, height);
      const scratch = document.createElement("canvas");
      scratch.width = width;
      scratch.height = height;
      scratch.getContext("2d")?.putImageData(image, 0, 0);
      context.imageSmoothingEnabled = false;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(scratch, 0, 0, canvas.width, canvas.height);
    },
    resize(width, height, dpr) {
      canvas.width = Math.max(1, Math.round(width * Math.min(dpr, 2)));
      canvas.height = Math.max(1, Math.round(height * Math.min(dpr, 2)));
    },
  };
}
