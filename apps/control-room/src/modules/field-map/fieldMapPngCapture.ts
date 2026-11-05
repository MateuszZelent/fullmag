import { planarExportFilename } from "./fieldMapExport";
import {
  getScalarColorPaletteStops,
  normalizeScalarColorPalette,
} from "@/shared/visualization/scalarColorPalette";

const MAX_CAPTURE_EDGE = 8_192;
const MAX_CAPTURE_PIXELS = 32 * 1024 * 1024;
const MAX_CAPTURE_SCALE = 2;

interface CapturedEvidence {
  canonicalUnit?: unknown;
  component?: unknown;
  defaultPlane?: unknown;
  fieldRevision?: unknown;
  quantityId?: unknown;
  resolvedCoordinateM?: unknown;
  sourceId?: unknown;
  sourceKind?: unknown;
  status?: unknown;
}

export interface CapturedFieldOverlayIdentity {
  id: string;
  quantityId: string;
  sample: string;
  layers: readonly string[];
}

export interface VisibleFieldMapCaptureSnapshot {
  stage: HTMLElement;
  stageRect: DOMRect;
  sourceCanvases: readonly HTMLCanvasElement[];
  axes: readonly HTMLElement[];
  legends: readonly HTMLElement[];
  diagnostics: readonly HTMLElement[];
  overlayIdentity: readonly CapturedFieldOverlayIdentity[];
  evidence: CapturedEvidence;
  unit: string;
  filename: string;
  identity: string;
}

export interface FieldMapPngCapture {
  blob: Blob;
  filename: string;
  /** Exact captured view identity used to name and validate the PNG. */
  identity: string;
}

/**
 * Captures the committed browser composition. The server PNG endpoint only
 * represents a single raster, so this path reads the visible canvases and
 * presentation labels already mounted by Field Map.
 */
export async function captureVisibleFieldMapPng(
  root: HTMLElement,
): Promise<FieldMapPngCapture> {
  const snapshot = resolveVisibleFieldMapCapture(root);
  const output = composeCapture(snapshot);
  const blob = await canvasToPng(output);
  const current = resolveVisibleFieldMapCapture(root);
  if (current.identity !== snapshot.identity) {
    throw captureFailure("the visible field map changed while the PNG was being encoded. Try again.");
  }
  return { blob, filename: snapshot.filename, identity: snapshot.identity };
}

/** Validates the evidence and resolves only canvases from the committed view. */
export function resolveVisibleFieldMapCapture(
  root: HTMLElement,
): VisibleFieldMapCaptureSnapshot {
  const evidenceElement = root.querySelector<HTMLElement>('[aria-label="Planar field evidence"]');
  if (!evidenceElement) throw captureFailure("the active 2D view has no field evidence.");
  const evidence = parseEvidence(evidenceElement.dataset.planarEvidence);
  if (evidenceElement.dataset.planarStatus !== "ready" || evidence.status !== "ready") {
    throw captureFailure("the displayed field evidence is not current.");
  }
  if (
    (evidence.sourceKind !== "default" && evidence.sourceKind !== "monitor") ||
    typeof evidence.sourceId !== "string" || !evidence.sourceId ||
    typeof evidence.quantityId !== "string" || !evidence.quantityId ||
    !isRevision(evidence.fieldRevision)
  ) {
    throw captureFailure("the displayed field identity is incomplete.");
  }

  const stage = root.querySelector<HTMLElement>(".fm-field-map__stage");
  if (!stage) throw captureFailure("the active 2D drawing area is unavailable.");
  const stageRect = stage.getBoundingClientRect();
  if (!positiveSize(stageRect.width, stageRect.height)) {
    throw captureFailure("the active 2D drawing area has zero dimensions.");
  }

  const composition = root.querySelector<HTMLElement>(".fm-field-map__composition-buffers");
  let renderedRoot: ParentNode = root;
  let compositionIdentity: readonly unknown[] = [];
  if (composition) {
    const state = composition.dataset.planarCompositionState;
    if (state === "pending") {
      throw captureFailure("the visible field layers are still preparing.");
    }
    if (state === "unavailable" || !state) {
      throw captureFailure("the visible field composition is unavailable.");
    }
    if (state !== "verified" && state !== "unverified") {
      throw captureFailure("the visible field composition has an unknown state.");
    }
    const visibleSlotId = composition.dataset.planarCompositionVisibleSlot;
    if (visibleSlotId !== "A" && visibleSlotId !== "B") {
      throw captureFailure("there is no committed visible field-layer buffer.");
    }
    const visibleSlots = Array.from(composition.querySelectorAll<HTMLElement>("[data-planar-composition-slot]"))
      .filter((slot) => slot.getAttribute("aria-hidden") === "false");
    const visibleSlot = visibleSlots.find((slot) => slot.dataset.planarCompositionSlot === visibleSlotId);
    if (visibleSlots.length !== 1 || !visibleSlot || !elementIsVisible(visibleSlot, composition)) {
      throw captureFailure("the committed field-layer buffer is not visible.");
    }
    renderedRoot = visibleSlot;
    compositionIdentity = [state, visibleSlotId];
  }

  const sourceCanvases = Array.from(renderedRoot.querySelectorAll<HTMLCanvasElement>("canvas.fm-field-map__canvas"))
    .filter((canvas) => elementIsVisible(canvas, renderedRoot));
  if (!sourceCanvases.length) throw captureFailure("the active field map has no visible drawing canvases.");
  for (const canvas of sourceCanvases) {
    if (canvas.width <= 0 || canvas.height <= 0) {
      throw captureFailure("a visible field layer has an empty drawing buffer.");
    }
    const rect = canvas.getBoundingClientRect();
    if (!positiveSize(rect.width, rect.height)) {
      throw captureFailure("a visible field layer has zero dimensions.");
    }
  }

  const overlayIdentity = resolveOverlayIdentity(sourceCanvases);
  const axes = Array.from(renderedRoot.querySelectorAll<HTMLElement>(".fm-field-map__axes"))
    .filter((element) => elementIsVisible(element, renderedRoot));
  const legends = Array.from(root.querySelectorAll<HTMLElement>(".fm-field-map__colorbar"))
    .filter((element) => elementIsVisible(element, root));
  const diagnostics = Array.from(root.querySelectorAll<HTMLElement>(".fm-field-map__stage .fm-field-map__diagnostic"))
    .filter((element) => elementIsVisible(element, stage));
  const unit = legends
    .map((legend) => legend.querySelector<HTMLElement>(".fm-field-map__colorbar-unit")?.textContent?.trim())
    .find((value): value is string => Boolean(value)) ??
    (typeof evidence.canonicalUnit === "string" ? evidence.canonicalUnit : "unit-unknown");
  const filename = capturedFilename(evidence, overlayIdentity, unit);
  const identity = JSON.stringify({
    evidence,
    composition: compositionIdentity,
    canvases: sourceCanvases.map((canvas) => [
      canvas.getAttribute("aria-label"),
      canvas.dataset.planarOverlayId ?? null,
      canvas.dataset.planarOverlayLayer ?? null,
      canvas.dataset.planarOverlayQuantity ?? null,
      canvas.dataset.planarOverlaySample ?? null,
      canvas.width,
      canvas.height,
      relativeRect(canvas.getBoundingClientRect(), stageRect),
    ]),
    overlays: overlayIdentity,
    axes: axes.map((element) => annotationIdentity(element, stageRect)),
    legends: legends.map((element) => annotationIdentity(element, stageRect)),
  });

  return {
    stage,
    stageRect,
    sourceCanvases,
    axes,
    legends,
    diagnostics,
    overlayIdentity,
    evidence,
    unit,
    filename,
    identity,
  };
}

function parseEvidence(value: string | undefined): CapturedEvidence {
  if (!value) throw captureFailure("the active 2D view has no captured field identity.");
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as CapturedEvidence;
    }
  } catch {
    // The visible evidence is the authority; malformed evidence fails closed.
  }
  throw captureFailure("the active 2D view has malformed field evidence.");
}

function resolveOverlayIdentity(
  canvases: readonly HTMLCanvasElement[],
): CapturedFieldOverlayIdentity[] {
  const layers = new Map<string, { quantityId: string; sample: string; kinds: Set<string> }>();
  for (const canvas of canvases) {
    const id = canvas.dataset.planarOverlayId;
    if (!id) continue;
    const quantityId = canvas.dataset.planarOverlayQuantity;
    const sample = canvas.dataset.planarOverlaySample;
    const layer = canvas.dataset.planarOverlayLayer;
    if (!quantityId || !sample || (layer !== "raster" && layer !== "vectors")) {
      throw captureFailure(`field overlay ${id} has incomplete capture identity.`);
    }
    if (
      canvas.dataset.planarOverlayRenderedCurrent !== "true" ||
      canvas.dataset.planarOverlayRenderedSample !== sample
    ) {
      throw captureFailure(`field overlay ${id} has pixels that are not current.`);
    }
    const renderedEvidence = parseOverlayRenderEvidence(canvas.dataset.planarOverlayRenderedEvidence, id);
    if (renderedEvidence.sampleIdentity !== sample) {
      throw captureFailure(`field overlay ${id} render evidence does not match its visible sample.`);
    }
    const previous = layers.get(id);
    if (previous && (previous.quantityId !== quantityId || previous.sample !== sample)) {
      throw captureFailure(`field overlay ${id} has inconsistent capture identity.`);
    }
    const entry = previous ?? { quantityId, sample, kinds: new Set<string>() };
    entry.kinds.add(layer);
    layers.set(id, entry);
  }
  return Array.from(layers, ([id, entry]) => {
    if (!entry.kinds.has("raster") || !entry.kinds.has("vectors")) {
      throw captureFailure(`field overlay ${id} is missing a visible canvas layer.`);
    }
    return { id, quantityId: entry.quantityId, sample: entry.sample, layers: [...entry.kinds].sort() };
  });
}

function parseOverlayRenderEvidence(value: string | undefined, id: string): { sampleIdentity?: unknown } {
  if (!value) throw captureFailure(`field overlay ${id} has no render acknowledgement.`);
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as { sampleIdentity?: unknown };
    }
  } catch {
    // Fail closed below when renderer evidence cannot be parsed.
  }
  throw captureFailure(`field overlay ${id} has malformed render evidence.`);
}

function capturedFilename(
  evidence: CapturedEvidence,
  overlays: readonly CapturedFieldOverlayIdentity[],
  unit: string,
): string {
  const source = evidence.sourceKind === "default"
    ? `default-${typeof evidence.defaultPlane === "string" ? evidence.defaultPlane : "plane"}-${typeof evidence.resolvedCoordinateM === "number" && Number.isFinite(evidence.resolvedCoordinateM)
      ? evidence.resolvedCoordinateM.toExponential(6)
      : "coordinate"}`
    : String(evidence.sourceId);
  const layerLabel = overlays.length
    ? `-layers-${overlays.length}-${overlays.map((layer) => `${layer.id}-${layer.quantityId}`).join("-")}-${shortHash(JSON.stringify(overlays))}`
    : "";
  return planarExportFilename({
    fieldRevision: evidence.fieldRevision as number | string,
    sourceLabel: `${source}${layerLabel}`,
    quantityId: String(evidence.quantityId),
    unit,
    extension: "png",
  });
}

function composeCapture(snapshot: VisibleFieldMapCaptureSnapshot): HTMLCanvasElement {
  const width = snapshot.stageRect.width;
  const height = snapshot.stageRect.height;
  const scale = Math.min(
    MAX_CAPTURE_SCALE,
    MAX_CAPTURE_EDGE / width,
    MAX_CAPTURE_EDGE / height,
    Math.sqrt(MAX_CAPTURE_PIXELS / (width * height)),
  );
  if (!Number.isFinite(scale) || scale <= 0) {
    throw captureFailure("the requested capture dimensions are invalid.");
  }
  const canvas = snapshot.stage.ownerDocument.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(width * scale));
  canvas.height = Math.max(1, Math.floor(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw captureFailure("the browser cannot create a 2D PNG capture surface.");
  context.scale(scale, scale);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  fillCaptureBackground(context, snapshot.stage);

  for (const source of snapshot.sourceCanvases) drawSourceCanvas(context, source, snapshot.stageRect);
  for (const axis of snapshot.axes) drawAxes(context, axis, snapshot.stageRect);
  for (const legend of snapshot.legends) drawLegend(context, legend, snapshot.stageRect);
  for (const diagnostic of snapshot.diagnostics) drawTextLeaves(context, diagnostic, snapshot.stageRect);
  return canvas;
}

function fillCaptureBackground(context: CanvasRenderingContext2D, stage: HTMLElement): void {
  const root = stage.closest<HTMLElement>(".fm-field-map") ?? stage;
  const style = computedStyle(root);
  context.fillStyle = style?.backgroundColor && !isTransparent(style.backgroundColor)
    ? style.backgroundColor
    : "white";
  const rect = stage.getBoundingClientRect();
  context.fillRect(0, 0, rect.width, rect.height);
}

function drawSourceCanvas(
  context: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  stageRect: DOMRect,
): void {
  const rect = source.getBoundingClientRect();
  const x = rect.left - stageRect.left;
  const y = rect.top - stageRect.top;
  const style = computedStyle(source);
  context.save();
  const opacity = Number.parseFloat(style?.opacity ?? "1");
  context.globalAlpha = Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1;
  if (!source.classList.contains("fm-field-map__canvas--overlay")) {
    const background = style?.backgroundColor;
    if (background && !isTransparent(background)) {
      context.fillStyle = background;
      context.fillRect(x, y, rect.width, rect.height);
    }
  }
  try {
    context.drawImage(source, x, y, rect.width, rect.height);
  } catch (error) {
    throw captureFailure(error instanceof Error ? error.message : "a visible field layer could not be read.");
  }
  const outlineWidth = Number.parseFloat(style?.outlineWidth ?? "0");
  if (style && outlineWidth > 0 && style.outlineStyle !== "none") {
    context.strokeStyle = style.outlineColor || "transparent";
    context.lineWidth = outlineWidth;
    context.strokeRect(x, y, rect.width, rect.height);
  }
  context.restore();
}

function drawAxes(
  context: CanvasRenderingContext2D,
  axes: HTMLElement,
  stageRect: DOMRect,
): void {
  for (const track of axes.querySelectorAll<HTMLElement>(".fm-field-map__axis-track")) {
    if (!elementIsVisible(track, axes)) continue;
    const rect = track.getBoundingClientRect();
    const style = computedStyle(track);
    context.save();
    context.strokeStyle = style?.borderTopColor || style?.borderRightColor || "currentColor";
    context.lineWidth = Math.max(0.5, Number.parseFloat(style?.borderTopWidth ?? "1"));
    context.beginPath();
    if (track.closest(".fm-field-map__axis--horizontal")) {
      const y = rect.top - stageRect.top;
      context.moveTo(rect.left - stageRect.left, y);
      context.lineTo(rect.right - stageRect.left, y);
    } else {
      const x = rect.right - stageRect.left;
      context.moveTo(x, rect.top - stageRect.top);
      context.lineTo(x, rect.bottom - stageRect.top);
    }
    context.stroke();
    context.restore();
  }
  for (const mark of axes.querySelectorAll<HTMLElement>(".fm-field-map__axis-mark")) {
    if (!elementIsVisible(mark, axes)) continue;
    const rect = relativeRect(mark.getBoundingClientRect(), stageRect);
    const style = computedStyle(mark);
    context.fillStyle = style?.backgroundColor || "currentColor";
    context.fillRect(rect.left, rect.top, rect.width, rect.height);
  }
  drawTextLeaves(context, axes, stageRect);
}

function drawLegend(
  context: CanvasRenderingContext2D,
  legend: HTMLElement,
  stageRect: DOMRect,
): void {
  const rect = relativeRect(legend.getBoundingClientRect(), stageRect);
  const style = computedStyle(legend);
  context.save();
  if (style?.backgroundColor && !isTransparent(style.backgroundColor)) {
    context.fillStyle = style.backgroundColor;
    roundedRect(context, rect.left, rect.top, rect.width, rect.height, parseFloat(style.borderRadius) || 0);
    context.fill();
  }
  const borderWidth = Number.parseFloat(style?.borderTopWidth ?? "0");
  if (style && borderWidth > 0 && style.borderTopStyle !== "none") {
    context.strokeStyle = style?.borderTopColor || "transparent";
    context.lineWidth = borderWidth;
    roundedRect(context, rect.left, rect.top, rect.width, rect.height, parseFloat(style.borderRadius) || 0);
    context.stroke();
  }
  context.restore();

  for (const ramp of legend.querySelectorAll<HTMLElement>(".fm-field-map__colorbar-ramp")) {
    if (!elementIsVisible(ramp, legend)) continue;
    drawPaletteRamp(context, ramp, stageRect);
  }
  for (const swatch of legend.querySelectorAll<HTMLCanvasElement>(".fm-field-map__direction-swatch")) {
    if (!elementIsVisible(swatch, legend)) continue;
    if (swatch.width <= 0 || swatch.height <= 0) {
      throw captureFailure("a visible direction legend has an empty drawing buffer.");
    }
    const box = relativeRect(swatch.getBoundingClientRect(), stageRect);
    context.drawImage(swatch, box.left, box.top, box.width, box.height);
  }
  drawTextLeaves(context, legend, stageRect);
}

function drawPaletteRamp(
  context: CanvasRenderingContext2D,
  ramp: HTMLElement,
  stageRect: DOMRect,
): void {
  const rect = relativeRect(ramp.getBoundingClientRect(), stageRect);
  if (!positiveSize(rect.width, rect.height)) return;
  const stops = getScalarColorPaletteStops(normalizeScalarColorPalette(ramp.dataset.colormap));
  const gradient = context.createLinearGradient(rect.left, rect.top, rect.left + rect.width, rect.top);
  stops.forEach((stop, index) => {
    gradient.addColorStop(index / Math.max(1, stops.length - 1), `rgb(${Math.round(stop[0] * 255)}, ${Math.round(stop[1] * 255)}, ${Math.round(stop[2] * 255)})`);
  });
  context.fillStyle = gradient;
  context.fillRect(rect.left, rect.top, rect.width, rect.height);
  const style = computedStyle(ramp);
  const borderWidth = Number.parseFloat(style?.borderTopWidth ?? "0");
  if (borderWidth > 0) {
    context.strokeStyle = style?.borderTopColor || "transparent";
    context.lineWidth = borderWidth;
    context.strokeRect(rect.left, rect.top, rect.width, rect.height);
  }
}

function drawTextLeaves(
  context: CanvasRenderingContext2D,
  root: HTMLElement,
  stageRect: DOMRect,
): void {
  for (const element of root.querySelectorAll<HTMLElement>("span, p, figcaption")) {
    if (element.children.length > 0 || !elementIsVisible(element, root)) continue;
    const text = element.textContent?.replace(/\s+/g, " ").trim();
    if (!text) continue;
    drawDomText(context, element, text, stageRect);
  }
}

function drawDomText(
  context: CanvasRenderingContext2D,
  element: HTMLElement,
  text: string,
  stageRect: DOMRect,
): void {
  const rect = relativeRect(element.getBoundingClientRect(), stageRect);
  if (!positiveSize(rect.width, rect.height)) return;
  const style = computedStyle(element);
  context.save();
  context.fillStyle = style?.color || "black";
  context.font = style?.font || [style?.fontStyle, style?.fontVariant, style?.fontWeight, style?.fontSize, style?.fontFamily]
    .filter(Boolean).join(" ") || "12px sans-serif";
  context.textBaseline = "middle";
  const alignment = style?.textAlign;
  context.textAlign = alignment === "center" || alignment === "right" || alignment === "end" ? alignment : "left";
  const verticalAxisTitle = element.classList.contains("fm-field-map__axis-title") &&
    element.closest(".fm-field-map__axis--vertical") !== null;
  if (verticalAxisTitle) {
    context.translate(rect.left + rect.width / 2, rect.top + rect.height / 2);
    context.rotate(-Math.PI / 2);
    context.fillText(text, 0, 0, rect.height);
  } else if (element.tagName === "P") {
    drawWrappedText(context, text, rect);
  } else {
    const x = context.textAlign === "right" ? rect.left + rect.width
      : context.textAlign === "center" ? rect.left + rect.width / 2
        : rect.left;
    context.fillText(text, x, rect.top + rect.height / 2, rect.width);
  }
  context.restore();
}

function drawWrappedText(
  context: CanvasRenderingContext2D,
  text: string,
  rect: { left: number; top: number; width: number; height: number },
): void {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && context.measureText(candidate).width > rect.width) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  const lineHeight = Number.parseFloat(computedFontSize(context.font)) * 1.35 || 16;
  const maxLines = Math.max(1, Math.floor(rect.height / lineHeight));
  const visible = lines.slice(0, maxLines);
  visible.forEach((value, index) => {
    context.fillText(value, rect.left, rect.top + lineHeight * (index + 0.5), rect.width);
  });
}

function computedFontSize(font: string): string {
  const match = font.match(/(?:^|\s)(\d+(?:\.\d+)?px)(?:\s|\/)/);
  return match?.[1] ?? "12px";
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const bounded = Math.min(Math.max(radius, 0), width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + bounded, y);
  context.lineTo(x + width - bounded, y);
  context.quadraticCurveTo(x + width, y, x + width, y + bounded);
  context.lineTo(x + width, y + height - bounded);
  context.quadraticCurveTo(x + width, y + height, x + width - bounded, y + height);
  context.lineTo(x + bounded, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - bounded);
  context.lineTo(x, y + bounded);
  context.quadraticCurveTo(x, y, x + bounded, y);
  context.closePath();
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(captureFailure("the browser could not encode the current 2D view as PNG."));
      }, "image/png");
    } catch (error) {
      reject(captureFailure(error instanceof Error ? error.message : "the browser could not encode the current 2D view as PNG."));
    }
  });
}

function elementIsVisible(element: Element, boundary: ParentNode): boolean {
  let current: Element | null = element;
  while (current && current !== boundary) {
    if (current.hasAttribute("hidden")) return false;
    const style = computedStyle(current);
    if (style?.display === "none" || style?.visibility === "hidden" || Number.parseFloat(style?.opacity ?? "1") === 0) {
      return false;
    }
    current = current.parentElement;
  }
  const rect = element.getBoundingClientRect();
  return positiveSize(rect.width, rect.height);
}

function computedStyle(element: Element): CSSStyleDeclaration | null {
  return element.ownerDocument.defaultView?.getComputedStyle(element) ?? null;
}

function annotationIdentity(element: HTMLElement, stageRect: DOMRect): readonly unknown[] {
  const style = computedStyle(element);
  return [
    element.className,
    element.textContent?.replace(/\s+/g, " ").trim(),
    element.querySelector<HTMLElement>(".fm-field-map__colorbar-ramp")?.dataset.colormap ?? null,
    style?.color ?? null,
    style?.backgroundColor ?? null,
    relativeRect(element.getBoundingClientRect(), stageRect),
  ];
}

function relativeRect(rect: DOMRect, origin: DOMRect): { left: number; top: number; width: number; height: number } {
  return {
    left: rect.left - origin.left,
    top: rect.top - origin.top,
    width: rect.width,
    height: rect.height,
  };
}

function positiveSize(width: number, height: number): boolean {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}

function isRevision(value: unknown): value is string | number {
  return (typeof value === "string" && value.length > 0) ||
    (typeof value === "number" && Number.isFinite(value));
}

function isTransparent(value: string): boolean {
  return value === "transparent" || /rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(value);
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function captureFailure(message: string): Error {
  return new Error(`Field Map PNG export failed: ${message}`);
}
