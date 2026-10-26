import {
  Color,
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
}

const captureSources = new WeakMap<HTMLCanvasElement, Viewport3DCaptureSource>();
const sceneLayer = 0;
const annotationLayer = 31;

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

async function renderSceneCanvas(
  source: Viewport3DCaptureSource,
  canvas: HTMLCanvasElement,
  background: Viewport3DImageCaptureOptions["background"],
  annotations: boolean,
): Promise<HTMLCanvasElement> {
  const { renderer, scene, camera } = source;
  const size = renderer.getDrawingBufferSize(new Vector2());
  const width = Math.floor(size.x);
  const height = Math.floor(size.y);
  if (width <= 0 || height <= 0) throw fail("the viewport drawing buffer is empty. Resize the viewport and try again.");

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
  const target = new WebGLRenderTarget(width, height, {
    depthBuffer: true,
    format: RGBAFormat,
    stencilBuffer: false,
    type: UnsignedByteType,
  });
  target.texture.colorSpace = renderer.outputColorSpace;
  target.texture.generateMipmaps = false;
  const pixels = new Uint8Array(width * height * 4);
  let renderError: unknown;
  let restoreError: unknown;

  try {
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
        const alpha = pixels[offset + 3];
        const out = destinationOffset + column * 4;
        if (background === "transparent") {
          image.data[out] = unpremultiplySrgbChannel(pixels[offset], alpha);
          image.data[out + 1] = unpremultiplySrgbChannel(pixels[offset + 1], alpha);
          image.data[out + 2] = unpremultiplySrgbChannel(pixels[offset + 2], alpha);
        } else {
          image.data[out] = pixels[offset];
          image.data[out + 1] = pixels[offset + 1];
          image.data[out + 2] = pixels[offset + 2];
        }
        image.data[out + 3] = alpha;
      }
    }
    context.putImageData(image, 0, 0);
    return createOutputCanvas(document, baseCanvas, canvas, width, height, annotations);
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
    target.dispose();
    if (renderError == null && restoreError != null) {
      throw fail("the renderer state could not be restored after capture.");
    }
  }
}

/**
 * Captures the currently composed opaque view. Transparent exports use a temporary RGBA target
 * in the same renderer and therefore do not include EffectComposer post-processing.
 */
export async function captureViewport3DImage(
  canvas: HTMLCanvasElement,
  options: Viewport3DImageCaptureOptions,
): Promise<Blob> {
  const source = captureSources.get(canvas);
  if (!source) throw fail("the viewport capture source is not registered. Mount Viewport3DCaptureSource inside the scene.");
  assertCaptureReady(canvas, source);

  if (options.background === "view") {
    const output = createOutputCanvas(
      canvas.ownerDocument,
      canvas,
      canvas,
      canvas.width,
      canvas.height,
      options.annotations,
    );
    return canvasToBlob(output);
  }

  const rendered = await renderSceneCanvas(source, canvas, options.background, options.annotations);
  return canvasToBlob(rendered);
}
