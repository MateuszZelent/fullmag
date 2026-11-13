import {
  Color,
  DataUtils,
  RGBAFormat,
  UnsignedByteType,
  Vector2,
  Vector4,
  WebGLRenderTarget,
  type Camera,
  type Scene,
  type WebGLRenderer,
} from "three";

export interface Viewport3DCaptureSource {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: Camera;
}

export interface Viewport3DImageCaptureOptions {
  background: "view" | "transparent";
  annotations: boolean;
  scale?: number;
}

export interface Viewport3DCapturePipelineRenderOptions {
  annotations: boolean;
  /** Requests the final composed linear premultiplied RGBA16F frame for PNG encoding. */
  pixels?: boolean;
}

export interface Viewport3DComposedCaptureFrame {
  /** Four half-float RGBA channels per pixel, with rows ordered bottom-up. */
  pixels: Uint16Array;
}

export interface Viewport3DCapturePipeline {
  /** Resizes post-processing targets to physical drawing-buffer pixels. */
  resize(width: number, height: number): void;
  /** Renders the final composed frame synchronously and may return its RGBA16F pixels. */
  render(options: Viewport3DCapturePipelineRenderOptions): Viewport3DComposedCaptureFrame | void;
}

const captureSources = new WeakMap<HTMLCanvasElement, Viewport3DCaptureSource>();
const capturePipelines = new WeakMap<HTMLCanvasElement, Viewport3DCapturePipeline>();
const sceneLayer = 0;
const annotationLayer = 31;
const MAX_CAPTURE_EDGE = 8192;
const MAX_CAPTURE_PIXELS = 16_000_000;

/** Associates the live R3F scene with its renderer canvas for bounded exports. */
export function registerViewport3DCaptureSource(
  canvas: HTMLCanvasElement,
  source: Viewport3DCaptureSource,
): () => void {
  captureSources.set(canvas, source);
  return () => {
    if (captureSources.get(canvas) === source) captureSources.delete(canvas);
  };
}

/** Registers the shared, post-processed capture path for both PNG backgrounds. */
export function registerViewport3DCapturePipeline(
  canvas: HTMLCanvasElement,
  pipeline: Viewport3DCapturePipeline,
): () => void {
  capturePipelines.set(canvas, pipeline);
  return () => {
    if (capturePipelines.get(canvas) === pipeline) capturePipelines.delete(canvas);
  };
}

function fail(message: string): Error {
  return new Error(`Viewport PNG export failed: ${message}`);
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return clamped <= 0.0031308
    ? clamped * 12.92
    : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

/** Converts an sRGB-encoded, linearly premultiplied color channel to straight-alpha sRGB. */
export function unpremultiplySrgbChannel(encodedChannel: number, alphaByte: number): number {
  if (!Number.isFinite(alphaByte) || alphaByte <= 0) return 0;
  if (alphaByte >= 255) {
    return Math.min(255, Math.max(0, Math.round(Number.isFinite(encodedChannel) ? encodedChannel : 0)));
  }
  const channel = Math.min(1, Math.max(0, Number.isFinite(encodedChannel) ? encodedChannel / 255 : 0));
  const alpha = alphaByte / 255;
  const straightLinear = srgbToLinear(channel) / alpha;
  return Math.round(linearToSrgb(straightLinear) * 255);
}

function assertCaptureReady(canvas: HTMLCanvasElement, source: Viewport3DCaptureSource): void {
  if (source.renderer.getContext().isContextLost()) {
    throw fail("the WebGL context was lost. Reopen the viewport before exporting.");
  }
  const bufferSize = source.renderer.getDrawingBufferSize(new Vector2());
  if (
    canvas.width <= 0 ||
    canvas.height <= 0 ||
    bufferSize.x <= 0 ||
    bufferSize.y <= 0
  ) {
    throw fail("the viewport drawing buffer is empty. Resize the viewport and try again.");
  }
}

function resolveCaptureSize(
  canvas: HTMLCanvasElement,
  scale: number | undefined,
): { width: number; height: number } {
  const normalizedScale = scale ?? 1;
  if (normalizedScale !== 1 && normalizedScale !== 2 && normalizedScale !== 4) {
    throw fail("capture scale must be 1, 2, or 4. Choose a supported export scale and try again.");
  }
  const rect = canvas.getBoundingClientRect();
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) {
    throw fail("the viewport layout is empty. Resize the viewport and try again.");
  }
  const width = Math.max(1, Math.round(rect.width * normalizedScale));
  const height = Math.max(1, Math.round(rect.height * normalizedScale));
  if (width > MAX_CAPTURE_EDGE || height > MAX_CAPTURE_EDGE) {
    throw fail(`the requested export is ${width} × ${height}px. The maximum is ${MAX_CAPTURE_EDGE} pixels per side; choose a smaller viewport or export scale.`);
  }
  if (width * height > MAX_CAPTURE_PIXELS) {
    throw fail(`the requested export is ${width} × ${height}px (${(width * height / 1_000_000).toFixed(1)} million pixels). The limit is 16 million pixels; choose a smaller viewport or export scale.`);
  }
  return { width, height };
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(fail("the browser could not encode the current viewport as PNG."));
      }, "image/png");
    } catch (error) {
      reject(fail(error instanceof Error ? error.message : "the browser could not read the viewport canvas."));
    }
  });
}

function topLevelCommaParts(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function gradientAngle(value: string): number {
  const direction = value.trim().toLowerCase();
  if (direction.endsWith("deg")) {
    const degrees = Number.parseFloat(direction);
    return Number.isFinite(degrees) ? degrees : 90;
  }
  if (direction === "to right") return 90;
  if (direction === "to left") return 270;
  if (direction === "to top") return 0;
  if (direction === "to bottom") return 180;
  if (direction === "to top right" || direction === "to right top") return 45;
  if (direction === "to bottom right" || direction === "to right bottom") return 135;
  if (direction === "to bottom left" || direction === "to left bottom") return 225;
  if (direction === "to top left" || direction === "to left top") return 315;
  return 90;
}

interface GradientStop {
  color: string;
  offset: number | null;
}

function parseLinearGradient(value: string): { angle: number; stops: GradientStop[] } | null {
  const match = value.trim().match(/^linear-gradient\((.*)\)$/i);
  if (!match) return null;
  const parts = topLevelCommaParts(match[1]);
  if (parts.length < 2) return null;
  const firstPartIsDirection = /^(?:to\s|[-+]?(?:\d+\.?\d*|\.\d+)(?:deg|rad|turn|grad)\b)/i.test(parts[0]);
  const angle = firstPartIsDirection ? gradientAngle(parts.shift() ?? "90deg") : 90;
  const stops = parts.map((part): GradientStop | null => {
    const stop = part.match(/^(.*?)(?:\s+(-?(?:\d+\.?\d*|\.\d+)%))?$/);
    if (!stop?.[1]?.trim()) return null;
    const offset = stop[2] ? Number.parseFloat(stop[2]) / 100 : null;
    return { color: stop[1].trim(), offset: Number.isFinite(offset) ? offset : null };
  }).filter((stop): stop is GradientStop => Boolean(stop));
  return stops.length >= 2 ? { angle, stops } : null;
}

function resolveGradientStops(stops: GradientStop[]): Array<{ color: string; offset: number }> {
  const resolved = stops.map((stop) => stop.offset);
  if (resolved[0] == null) resolved[0] = 0;
  if (resolved[resolved.length - 1] == null) resolved[resolved.length - 1] = 1;
  let previousSpecified = 0;
  for (let index = 1; index < resolved.length; index += 1) {
    if (resolved[index] == null) continue;
    const start = resolved[previousSpecified] ?? 0;
    const end = resolved[index] ?? 1;
    const span = index - previousSpecified;
    for (let fill = 1; fill < span; fill += 1) {
      resolved[previousSpecified + fill] = start + ((end - start) * fill) / span;
    }
    previousSpecified = index;
  }
  return stops.map((stop, index) => ({
    color: stop.color,
    offset: Math.min(1, Math.max(0, resolved[index] ?? 0)),
  }));
}

function elementText(element: Element): string {
  if (element instanceof HTMLSelectElement) {
    return element.selectedOptions[0]?.textContent?.trim() ?? element.value;
  }
  return element.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function isVisible(element: Element, view: Window): boolean {
  const style = view.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
}

function roundedRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(Math.max(0, radius), width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function px(value: string): number {
  const result = Number.parseFloat(value);
  return Number.isFinite(result) ? result : 0;
}

function canvasRectForElement(
  element: Element,
  canvasRect: DOMRect,
  scaleX: number,
  scaleY: number,
): { x: number; y: number; width: number; height: number } {
  const rect = element.getBoundingClientRect();
  return {
    x: (rect.left - canvasRect.left) * scaleX,
    y: (rect.top - canvasRect.top) * scaleY,
    width: rect.width * scaleX,
    height: rect.height * scaleY,
  };
}

function drawSurface(
  context: CanvasRenderingContext2D,
  element: Element,
  rect: { x: number; y: number; width: number; height: number },
  style: CSSStyleDeclaration,
): void {
  const radius = px(style.borderTopLeftRadius) * Math.min(
    rect.width / Math.max(1, element.getBoundingClientRect().width),
    rect.height / Math.max(1, element.getBoundingClientRect().height),
  );
  roundedRectPath(context, rect.x, rect.y, rect.width, rect.height, radius);
  if (style.backgroundColor !== "transparent") {
    context.fillStyle = style.backgroundColor;
    context.fill();
  }
  const borderWidth = px(style.borderTopWidth);
  if (borderWidth > 0 && style.borderTopColor !== "transparent") {
    context.lineWidth = borderWidth * Math.max(1, rect.width / Math.max(1, element.getBoundingClientRect().width));
    context.strokeStyle = style.borderTopColor;
    context.stroke();
  }
}

function fitText(
  context: CanvasRenderingContext2D,
  text: string,
  availableWidth: number,
): string {
  if (availableWidth <= 0 || context.measureText(text).width <= availableWidth) return text;
  const ellipsis = "…";
  let output = text;
  while (output.length > 0 && context.measureText(`${output}${ellipsis}`).width > availableWidth) {
    output = output.slice(0, -1);
  }
  return output ? `${output}${ellipsis}` : "";
}

function drawText(
  context: CanvasRenderingContext2D,
  element: Element,
  canvasRect: DOMRect,
  scaleX: number,
  scaleY: number,
): void {
  const text = elementText(element);
  if (!text) return;
  const rect = canvasRectForElement(element, canvasRect, scaleX, scaleY);
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (!style) return;
  const fontSize = px(style.fontSize) * scaleY;
  const paddingLeft = px(style.paddingLeft) * scaleX;
  const paddingRight = px(style.paddingRight) * scaleX;
  const borderLeft = px(style.borderLeftWidth) * scaleX;
  const borderRight = px(style.borderRightWidth) * scaleX;
  context.save();
  context.beginPath();
  context.rect(rect.x, rect.y, rect.width, rect.height);
  context.clip();
  context.font = `${style.fontStyle} ${style.fontVariant} ${style.fontWeight} ${fontSize}px ${style.fontFamily}`;
  context.fillStyle = style.color;
  context.textBaseline = "middle";
  context.textAlign = style.textAlign === "right" ? "right" : style.textAlign === "center" ? "center" : "left";
  const left = rect.x + borderLeft + paddingLeft;
  const right = rect.x + rect.width - borderRight - paddingRight;
  const availableWidth = Math.max(0, right - left);
  const x = context.textAlign === "right" ? right : context.textAlign === "center" ? (left + right) / 2 : left;
  const y = rect.y + rect.height / 2 + px(style.lineHeight) * scaleY * 0.05;
  const fitted = fitText(context, text, availableWidth);
  context.fillText(fitted, x, y);
  context.restore();
}

function drawRamp(
  context: CanvasRenderingContext2D,
  ramp: Element,
  canvasRect: DOMRect,
  scaleX: number,
  scaleY: number,
): void {
  const rect = canvasRectForElement(ramp, canvasRect, scaleX, scaleY);
  const style = ramp.ownerDocument.defaultView?.getComputedStyle(ramp);
  if (!style) return;
  const radius = px(style.borderTopLeftRadius) * scaleY;
  roundedRectPath(context, rect.x, rect.y, rect.width, rect.height, radius);
  const gradient = parseLinearGradient(style.backgroundImage);
  if (gradient && rect.width > 0 && rect.height > 0) {
    const radians = ((gradient.angle - 90) * Math.PI) / 180;
    const half = Math.abs(rect.width * Math.cos(radians)) / 2 + Math.abs(rect.height * Math.sin(radians)) / 2;
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    const fill = context.createLinearGradient(
      centerX - Math.cos(radians) * half,
      centerY - Math.sin(radians) * half,
      centerX + Math.cos(radians) * half,
      centerY + Math.sin(radians) * half,
    );
    for (const stop of resolveGradientStops(gradient.stops)) {
      fill.addColorStop(stop.offset, stop.color);
    }
    context.fillStyle = fill;
  } else {
    context.fillStyle = style.backgroundColor;
  }
  context.fill();
  const borderWidth = px(style.borderTopWidth) * scaleX;
  if (borderWidth > 0) {
    context.lineWidth = borderWidth;
    context.strokeStyle = style.borderTopColor;
    context.stroke();
  }
}

function compositeAnnotations(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): void {
  const root = canvas.closest<HTMLElement>(".fm-viewport-3d");
  const view = canvas.ownerDocument.defaultView;
  if (!root || !view) throw fail("the viewport DOM is unavailable for annotation export.");
  const rootRect = root.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  if (rootRect.width <= 0 || rootRect.height <= 0 || canvasRect.width <= 0 || canvasRect.height <= 0) {
    throw fail("the viewport layout is empty. Resize the viewport and try again.");
  }
  const scaleX = width / canvasRect.width;
  const scaleY = height / canvasRect.height;

  const hud = root.querySelector<HTMLElement>(".fm-viewport-3d__hud");
  if (hud && isVisible(hud, view)) {
    for (const badge of hud.querySelectorAll<HTMLElement>(
      ":scope > span, :scope > .fm-viewport-3d__hud-info > span",
    )) {
      if (!isVisible(badge, view) || !elementText(badge)) continue;
      const rect = canvasRectForElement(badge, canvasRect, scaleX, scaleY);
      const style = view.getComputedStyle(badge);
      drawSurface(context, badge, rect, style);
      drawText(context, badge, canvasRect, scaleX, scaleY);
    }
  }

  const stack = root.querySelector<HTMLElement>(".fm-viewport-3d__colorbar-stack");
  if (!stack || !isVisible(stack, view)) return;
  context.save();
  context.beginPath();
  const stackRect = canvasRectForElement(stack, canvasRect, scaleX, scaleY);
  context.rect(stackRect.x, stackRect.y, stackRect.width, stackRect.height);
  context.clip();
  for (const card of stack.querySelectorAll<HTMLElement>(":scope > .fm-viewport-3d__colorbar")) {
    if (!isVisible(card, view)) continue;
    const cardRect = canvasRectForElement(card, canvasRect, scaleX, scaleY);
    drawSurface(context, card, cardRect, view.getComputedStyle(card));
    for (const child of card.querySelectorAll<HTMLElement>(
      ".fm-viewport-3d__colorbar-context, .fm-viewport-3d__colorbar-quantity, .fm-viewport-3d__colorbar-component, .fm-viewport-3d__colorbar-unit, .fm-viewport-3d__colorbar-range-label, .fm-viewport-3d__colorbar-limit",
    )) {
      if (isVisible(child, view)) {
        const childStyle = view.getComputedStyle(child);
        const childRect = canvasRectForElement(child, canvasRect, scaleX, scaleY);
        if (child.classList.contains("fm-viewport-3d__colorbar-unit")) {
          drawSurface(context, child, childRect, childStyle);
        }
        drawText(context, child, canvasRect, scaleX, scaleY);
      }
    }
    const ramp = card.querySelector<HTMLElement>(".fm-viewport-3d__colorbar-ramp");
    if (ramp && isVisible(ramp, view)) drawRamp(context, ramp, canvasRect, scaleX, scaleY);
  }
  context.restore();
}

function createOutputCanvas(
  document: Document,
  base: CanvasImageSource,
  annotationAnchor: HTMLCanvasElement,
  width: number,
  height: number,
  annotations: boolean,
): HTMLCanvasElement {
  const output = document.createElement("canvas");
  output.width = width;
  output.height = height;
  const context = output.getContext("2d");
  if (!context) throw fail("the browser could not create a 2D PNG compositor.");
  context.drawImage(base, 0, 0, width, height);
  if (annotations) compositeAnnotations(context, annotationAnchor, width, height);
  return output;
}

function renderScenePixels(
  source: Viewport3DCaptureSource,
  canvas: HTMLCanvasElement,
  background: Viewport3DImageCaptureOptions["background"],
  annotations: boolean,
  width: number,
  height: number,
): Uint8Array {
  const { renderer, scene, camera } = source;
  const previousTarget = renderer.getRenderTarget();
  const previousViewport = renderer.getViewport(new Vector4());
  const previousScissor = renderer.getScissor(new Vector4());
  const previousScissorTest = renderer.getScissorTest();
  const previousClearColor = renderer.getClearColor(new Color()).clone();
  const previousClearAlpha = renderer.getClearAlpha();
  const previousAutoClear = renderer.autoClear;
  const previousAutoClearColor = renderer.autoClearColor;
  const previousAutoClearDepth = renderer.autoClearDepth;
  const previousAutoClearStencil = renderer.autoClearStencil;
  const previousBackground = scene.background;
  const previousLayerMask = camera.layers.mask;
  let target: WebGLRenderTarget | null = null;
  let pixels: Uint8Array | null = null;
  let renderError: unknown;
  let restoreError: unknown;

  try {
    target = new WebGLRenderTarget(width, height, {
      depthBuffer: true,
      format: RGBAFormat,
      stencilBuffer: false,
      samples: renderer.getContext().getContextAttributes?.()?.antialias ? Math.min(4, renderer.capabilities?.maxSamples ?? 0) : 0,
      type: UnsignedByteType,
    });
    target.texture.colorSpace = renderer.outputColorSpace;
    target.texture.generateMipmaps = false;
    try {
      pixels = new Uint8Array(width * height * 4);
    } catch {
      throw fail("the browser could not allocate the PNG pixel buffer. Choose a smaller viewport or export scale.");
    }
    renderer.setRenderTarget(target);
    renderer.setViewport(0, 0, width, height);
    renderer.setScissor(0, 0, width, height);
    renderer.setScissorTest(false);
    renderer.autoClear = true;
    renderer.autoClearColor = true;
    renderer.autoClearDepth = true;
    renderer.autoClearStencil = true;
    if (background === "transparent") {
      scene.background = null;
      renderer.setClearColor(0x000000, 0);
    }
    camera.layers.mask = 1 << sceneLayer;
    renderer.render(scene, camera);
    if (annotations) {
      scene.background = null;
      camera.layers.mask = 1 << annotationLayer;
      renderer.clearDepth();
      renderer.autoClear = false;
      renderer.render(scene, camera);
    }
    if (renderer.getContext().isContextLost()) {
      throw fail("the WebGL context was lost while rendering the export. Reopen the viewport and try again.");
    }
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    return pixels;
  } catch (error) {
    renderError = error;
    throw error;
  } finally {
    scene.background = previousBackground;
    camera.layers.mask = previousLayerMask;
    const restore = (action: () => void) => {
      try {
        action();
      } catch (error) {
        if (restoreError == null) restoreError = error;
      }
    };
    restore(() => renderer.setRenderTarget(previousTarget));
    restore(() => renderer.setViewport(previousViewport));
    restore(() => renderer.setScissor(previousScissor));
    restore(() => renderer.setScissorTest(previousScissorTest));
    restore(() => renderer.setClearColor(previousClearColor, previousClearAlpha));
    restore(() => { renderer.autoClear = previousAutoClear; });
    restore(() => { renderer.autoClearColor = previousAutoClearColor; });
    restore(() => { renderer.autoClearDepth = previousAutoClearDepth; });
    restore(() => { renderer.autoClearStencil = previousAutoClearStencil; });
    target?.dispose();
    if (renderError == null && restoreError != null) {
      throw fail("the renderer state could not be restored after capture.");
    }
  }
}

function createPixelCanvas(
  canvas: HTMLCanvasElement,
  pixels: Uint8Array,
  width: number,
  height: number,
  background: Viewport3DImageCaptureOptions["background"],
  annotations: boolean,
): HTMLCanvasElement {
  const document = canvas.ownerDocument;
  const baseCanvas = document.createElement("canvas");
  baseCanvas.width = width;
  baseCanvas.height = height;
  const context = baseCanvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw fail("the browser could not create a PNG pixel buffer.");
  const image = context.createImageData(width, height);
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = (height - 1 - row) * width * 4;
    const destinationOffset = row * width * 4;
    for (let column = 0; column < width; column += 1) {
      const offset = sourceOffset + column * 4;
      const alpha = pixels[offset + 3] ?? 0;
      const out = destinationOffset + column * 4;
      if (background === "transparent") {
        image.data[out] = unpremultiplySrgbChannel(pixels[offset] ?? 0, alpha);
        image.data[out + 1] = unpremultiplySrgbChannel(pixels[offset + 1] ?? 0, alpha);
        image.data[out + 2] = unpremultiplySrgbChannel(pixels[offset + 2] ?? 0, alpha);
      } else {
        image.data[out] = pixels[offset] ?? 0;
        image.data[out + 1] = pixels[offset + 1] ?? 0;
        image.data[out + 2] = pixels[offset + 2] ?? 0;
      }
      image.data[out + 3] = alpha;
    }
  }
  context.putImageData(image, 0, 0);
  return createOutputCanvas(document, baseCanvas, canvas, width, height, annotations);
}

function validateComposedCaptureFrame(
  frame: Viewport3DComposedCaptureFrame,
  width: number,
  height: number,
): void {
  const expectedLength = width * height * 4;
  if (!frame || !(frame.pixels instanceof Uint16Array) || frame.pixels.length !== expectedLength) {
    throw fail(`the post-processing pipeline returned an invalid composed capture frame. Expected ${expectedLength} RGBA16F values for ${width} × ${height}px; try a smaller export scale or disable post-processing.`);
  }
  for (let index = 0; index < frame.pixels.length; index += 1) {
    // An all-ones exponent encodes either infinity or NaN in an IEEE 754 half-float.
    if ((frame.pixels[index]! & 0x7c00) === 0x7c00) {
      throw fail("the post-processing pipeline returned non-finite RGBA16F pixels. Try a smaller export scale or disable post-processing.");
    }
  }
}

function createComposedFrameCanvas(
  frame: Viewport3DComposedCaptureFrame,
  canvas: HTMLCanvasElement,
  background: Viewport3DImageCaptureOptions["background"],
  annotations: boolean,
  width: number,
  height: number,
): HTMLCanvasElement {
  validateComposedCaptureFrame(frame, width, height);
  const output = canvas.ownerDocument.createElement("canvas");
  output.width = width;
  output.height = height;
  const context = output.getContext("2d", { willReadFrequently: true });
  if (!context) throw fail("the browser could not create a PNG pixel buffer.");
  const image = context.createImageData(width, height);
  const { pixels } = frame;

  for (let row = 0; row < height; row += 1) {
    const sourceRow = height - 1 - row;
    for (let column = 0; column < width; column += 1) {
      const sourceOffset = (sourceRow * width + column) * 4;
      const red = DataUtils.fromHalfFloat(pixels[sourceOffset]!);
      const green = DataUtils.fromHalfFloat(pixels[sourceOffset + 1]!);
      const blue = DataUtils.fromHalfFloat(pixels[sourceOffset + 2]!);
      const sourceAlpha = Math.min(1, Math.max(0, DataUtils.fromHalfFloat(pixels[sourceOffset + 3]!)));
      let alphaForUnpremultiply = sourceAlpha;
      let alphaByte = Math.round(sourceAlpha * 255);

      if (background === "transparent") {
        const glowAlpha = Math.min(1, Math.max(0, red, green, blue));
        // Filtered additive light can overlap partially covered geometry.
        if (glowAlpha > sourceAlpha) {
          alphaByte = Math.ceil(glowAlpha * 255);
          alphaForUnpremultiply = alphaByte / 255;
        }
      }

      const destinationOffset = (row * width + column) * 4;
      image.data[destinationOffset] = Math.round(linearToSrgb(alphaForUnpremultiply > 0 ? red / alphaForUnpremultiply : 0) * 255);
      image.data[destinationOffset + 1] = Math.round(linearToSrgb(alphaForUnpremultiply > 0 ? green / alphaForUnpremultiply : 0) * 255);
      image.data[destinationOffset + 2] = Math.round(linearToSrgb(alphaForUnpremultiply > 0 ? blue / alphaForUnpremultiply : 0) * 255);
      image.data[destinationOffset + 3] = alphaByte;
    }
  }

  context.putImageData(image, 0, 0);
  if (annotations) compositeAnnotations(context, canvas, width, height);
  return output;
}

function compositeTransparentPipelineCanvas(
  output: HTMLCanvasElement,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  alphaPixels: Uint8Array,
  annotations: boolean,
): HTMLCanvasElement {
  const context = output.getContext("2d", { willReadFrequently: true });
  if (!context) throw fail("the browser could not create a transparent PNG compositor.");
  const image = context.getImageData(0, 0, width, height);
  for (let row = 0; row < height; row += 1) {
    const alphaRow = height - 1 - row;
    for (let column = 0; column < width; column += 1) {
      const offset = (row * width + column) * 4;
      const geometryAlpha = alphaPixels[(alphaRow * width + column) * 4 + 3] ?? 0;
      // Pure additive bloom has no geometry coverage. Give its radiance the
      // smallest alpha that can represent it without clipping straight RGB.
      const alpha = geometryAlpha > 0 ? geometryAlpha : Math.ceil(255 * Math.max(
        srgbToLinear((image.data[offset] ?? 0) / 255),
        srgbToLinear((image.data[offset + 1] ?? 0) / 255),
        srgbToLinear((image.data[offset + 2] ?? 0) / 255),
      ));
      image.data[offset] = unpremultiplySrgbChannel(image.data[offset] ?? 0, alpha);
      image.data[offset + 1] = unpremultiplySrgbChannel(image.data[offset + 1] ?? 0, alpha);
      image.data[offset + 2] = unpremultiplySrgbChannel(image.data[offset + 2] ?? 0, alpha);
      image.data[offset + 3] = alpha;
    }
  }
  context.putImageData(image, 0, 0);
  if (annotations) compositeAnnotations(context, canvas, width, height);
  return output;
}

function renderSceneCanvas(
  source: Viewport3DCaptureSource,
  canvas: HTMLCanvasElement,
  background: Viewport3DImageCaptureOptions["background"],
  annotations: boolean,
  width: number,
  height: number,
): HTMLCanvasElement {
  return createPixelCanvas(
    canvas,
    renderScenePixels(source, canvas, background, annotations, width, height),
    width,
    height,
    background,
    annotations,
  );
}

function renderPipelineCanvas(
  source: Viewport3DCaptureSource,
  pipeline: Viewport3DCapturePipeline,
  canvas: HTMLCanvasElement,
  background: Viewport3DImageCaptureOptions["background"],
  annotations: boolean,
  width: number,
  height: number,
): HTMLCanvasElement {
  const { renderer, scene, camera } = source;
  const previousSize = renderer.getSize(new Vector2());
  const previousDrawingBufferSize = renderer.getDrawingBufferSize(new Vector2());
  const previousPixelRatio = renderer.getPixelRatio();
  const previousTarget = renderer.getRenderTarget();
  const previousViewport = renderer.getViewport(new Vector4());
  const previousScissor = renderer.getScissor(new Vector4());
  const previousScissorTest = renderer.getScissorTest();
  const previousClearColor = renderer.getClearColor(new Color()).clone();
  const previousClearAlpha = renderer.getClearAlpha();
  const previousAutoClear = renderer.autoClear;
  const previousAutoClearColor = renderer.autoClearColor;
  const previousAutoClearDepth = renderer.autoClearDepth;
  const previousAutoClearStencil = renderer.autoClearStencil;
  const previousBackground = scene.background;
  const previousLayerMask = camera.layers.mask;
  let output: HTMLCanvasElement | null = null;
  let captureError: unknown;
  let restoreError: unknown;

  const restore = (action: () => void) => {
    try {
      action();
    } catch (error) {
      if (restoreError == null) restoreError = error;
    }
  };
  const restoreRendererState = () => {
    restore(() => renderer.setRenderTarget(previousTarget));
    restore(() => renderer.setViewport(previousViewport));
    restore(() => renderer.setScissor(previousScissor));
    restore(() => renderer.setScissorTest(previousScissorTest));
    restore(() => renderer.setClearColor(previousClearColor, previousClearAlpha));
    restore(() => { renderer.autoClear = previousAutoClear; });
    restore(() => { renderer.autoClearColor = previousAutoClearColor; });
    restore(() => { renderer.autoClearDepth = previousAutoClearDepth; });
    restore(() => { renderer.autoClearStencil = previousAutoClearStencil; });
  };

  try {
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    renderer.setRenderTarget(null);
    renderer.setViewport(0, 0, width, height);
    renderer.setScissor(0, 0, width, height);
    renderer.setScissorTest(false);
    renderer.autoClearColor = true;
    renderer.autoClearDepth = true;
    renderer.autoClearStencil = true;
    pipeline.resize(width, height);
    if (background === "transparent") {
      scene.background = null;
      renderer.setClearColor(0x000000, 0);
    }
    const composedFrame = pipeline.render({ annotations, pixels: true });
    if (renderer.getContext().isContextLost()) {
      throw fail("the WebGL context was lost while rendering the export. Reopen the viewport and try again.");
    }
    if (composedFrame !== undefined) {
      output = createComposedFrameCanvas(composedFrame, canvas, background, annotations, width, height);
    } else if (background === "transparent") {
      const beauty = createOutputCanvas(canvas.ownerDocument, canvas, canvas, width, height, false);
      const coverage = renderScenePixels(source, canvas, "transparent", annotations, width, height);
      output = compositeTransparentPipelineCanvas(beauty, canvas, width, height, coverage, annotations);
    } else {
      output = createOutputCanvas(canvas.ownerDocument, canvas, canvas, width, height, annotations);
    }
  } catch (error) {
    captureError = error;
  } finally {
    scene.background = previousBackground;
    camera.layers.mask = previousLayerMask;
    restore(() => renderer.setPixelRatio(previousPixelRatio));
    restore(() => renderer.setSize(previousSize.x, previousSize.y, false));
    restoreRendererState();
    restore(() => pipeline.resize(previousDrawingBufferSize.x, previousDrawingBufferSize.y));
    restore(() => pipeline.render({ annotations: true }));
    restore(() => { scene.background = previousBackground; });
    restore(() => { camera.layers.mask = previousLayerMask; });
    restoreRendererState();
  }

  if (captureError != null) throw captureError;
  if (restoreError != null) throw fail("the renderer or post-processing state could not be restored after capture.");
  if (!output) throw fail("the browser could not create the captured PNG image.");
  return output;
}

/**
 * Captures the composed viewport at a bounded output size. Pipelines that expose a final RGBA16F
 * frame use its color and alpha samples together; legacy pipelines retain the existing fallback.
 */
export async function captureViewport3DImage(
  canvas: HTMLCanvasElement,
  options: Viewport3DImageCaptureOptions,
): Promise<Blob> {
  const source = captureSources.get(canvas);
  if (!source) throw fail("the viewport capture source is not registered. Mount Viewport3DCaptureSource inside the scene.");
  assertCaptureReady(canvas, source);
  const { width, height } = resolveCaptureSize(canvas, options.scale);
  const deviceLimit = source.renderer.capabilities?.maxTextureSize ?? MAX_CAPTURE_EDGE;
  const context = source.renderer.getContext();
  const renderbufferLimit = typeof context.getParameter === "function" ? Number(context.getParameter(context.MAX_RENDERBUFFER_SIZE)) : deviceLimit;
  const maximum = Math.min(deviceLimit, Number.isFinite(renderbufferLimit) && renderbufferLimit > 0 ? renderbufferLimit : deviceLimit);
  if (width > maximum || height > maximum) {
    throw fail(`this device supports export targets up to ${maximum} pixels per side. Choose a smaller viewport or export scale.`);
  }
  const pipeline = capturePipelines.get(canvas);
  const rendered = pipeline
    ? renderPipelineCanvas(source, pipeline, canvas, options.background, options.annotations, width, height)
    : renderSceneCanvas(source, canvas, options.background, options.annotations, width, height);
  return canvasToBlob(rendered);
}
