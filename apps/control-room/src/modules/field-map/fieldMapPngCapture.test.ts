// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { resolveVisibleFieldMapCapture } from "./fieldMapPngCapture";

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

function setRect(element: Element, bounds: DOMRect): void {
  Object.defineProperty(element, "getBoundingClientRect", { configurable: true, value: () => bounds });
}

function makeCanvas(parent: Element, layer: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.className = "fm-field-map__canvas";
  canvas.width = 64;
  canvas.height = 48;
  canvas.setAttribute("data-test-layer", layer);
  setRect(canvas, rect(20, 30, 64, 48));
  parent.append(canvas);
  return canvas;
}

function makeEvidence(): Record<string, unknown> {
  return {
    canonicalUnit: "A/m",
    component: "magnitude",
    defaultPlane: "xy",
    fieldRevision: 12,
    quantityId: "m",
    resolvedCoordinateM: 3e-9,
    sourceId: "default",
    sourceKind: "default",
    status: "ready",
  };
}

function makeRoot(compositionState = "verified") {
  const root = document.createElement("section");
  root.className = "fm-field-map";
  const evidence = document.createElement("output");
  evidence.setAttribute("aria-label", "Planar field evidence");
  evidence.dataset.planarEvidence = JSON.stringify(makeEvidence());
  evidence.dataset.planarStatus = "ready";
  root.append(evidence);

  const stage = document.createElement("div");
  stage.className = "fm-field-map__stage";
  setRect(stage, rect(10, 20, 600, 500));
  root.append(stage);

  const composition = document.createElement("div");
  composition.className = "fm-field-map__composition-buffers";
  composition.dataset.planarCompositionState = compositionState;
  composition.dataset.planarCompositionVisibleSlot = "B";
  stage.append(composition);

  const slotA = document.createElement("div");
  slotA.dataset.planarCompositionSlot = "A";
  slotA.setAttribute("aria-hidden", "true");
  setRect(slotA, rect(20, 30, 64, 48));
  // A hidden preparing buffer is deliberately invalid and must never poison or
  // enter a capture of the committed B stack.
  makeCanvas(slotA, "hidden-A").width = 0;
  composition.append(slotA);

  const slotB = document.createElement("div");
  slotB.dataset.planarCompositionSlot = "B";
  slotB.setAttribute("aria-hidden", "false");
  setRect(slotB, rect(20, 30, 64, 48));
  composition.append(slotB);
  makeCanvas(slotB, "base-raster").setAttribute("aria-label", "Planar scalar field");
  makeCanvas(slotB, "base-glyphs").classList.add("fm-field-map__canvas--overlay");
  for (const [id, quantityId, sample] of [
    ["object:ferromagnet", "H_demag", "etag-overlay-3"],
    ["object:antiferromagnet", "H_eff", "etag-overlay-4"],
  ]) {
    for (const layer of ["raster", "vectors"] as const) {
      const overlay = makeCanvas(slotB, `overlay-${id}-${layer}`);
      overlay.dataset.planarOverlayId = id;
      overlay.dataset.planarOverlayLayer = layer;
      overlay.dataset.planarOverlayQuantity = quantityId;
      overlay.dataset.planarOverlaySample = sample;
      overlay.dataset.planarOverlayRenderedSample = sample;
      overlay.dataset.planarOverlayRenderedCurrent = "true";
      overlay.dataset.planarOverlayRenderedEvidence = JSON.stringify({ sampleIdentity: sample, renderKey: `render-${sample}` });
    }
  }

  const axes = document.createElement("div");
  axes.className = "fm-field-map__axes";
  axes.textContent = "X (nm) Y (nm)";
  setRect(axes, rect(20, 30, 64, 48));
  slotB.append(axes);
  const legend = document.createElement("aside");
  legend.className = "fm-field-map__colorbar";
  legend.setAttribute("aria-label", "Scalar color range");
  setRect(legend, rect(20, 100, 120, 40));
  legend.innerHTML = '<span class="fm-field-map__colorbar-quantity">H demag</span><span class="fm-field-map__colorbar-unit">A/m</span><span class="fm-field-map__colorbar-limit--min">-2</span><span class="fm-field-map__colorbar-limit--max">2</span><span class="fm-field-map__colorbar-ramp" data-colormap="coolwarm"></span>';
  stage.append(legend);
  return { root, stage, slotA, slotB, composition };
}

describe("visible field-map PNG capture", () => {
  it("uses ordered canvases only from the committed visible composition slot and captures its displayed labels", () => {
    const { root } = makeRoot();

    const snapshot = resolveVisibleFieldMapCapture(root);

    expect(snapshot.sourceCanvases.map((canvas) => canvas.getAttribute("data-test-layer"))).toEqual([
      "base-raster",
      "base-glyphs",
      "overlay-object:ferromagnet-raster",
      "overlay-object:ferromagnet-vectors",
      "overlay-object:antiferromagnet-raster",
      "overlay-object:antiferromagnet-vectors",
    ]);
    expect(snapshot.overlayIdentity).toEqual([
      expect.objectContaining({ id: "object:ferromagnet", quantityId: "H_demag", sample: "etag-overlay-3" }),
      expect.objectContaining({ id: "object:antiferromagnet", quantityId: "H_eff", sample: "etag-overlay-4" }),
    ]);
    expect(snapshot.axes).toHaveLength(1);
    expect(snapshot.legends).toHaveLength(1);
    expect(snapshot.unit).toBe("A/m");
    expect(snapshot.filename).toContain("h-demag");
    expect(snapshot.filename).toContain("layers-2-");
  });

  it("rejects a pending composition instead of exporting its previous visible buffer", () => {
    const { root } = makeRoot("pending");

    expect(() => resolveVisibleFieldMapCapture(root)).toThrow(/still preparing/);
  });

  it("rejects a visible layer with an empty drawing buffer", () => {
    const { root, slotB } = makeRoot();
    const vectorCanvas = slotB.querySelector('[data-test-layer="base-glyphs"]') as HTMLCanvasElement;
    vectorCanvas.height = 0;

    expect(() => resolveVisibleFieldMapCapture(root)).toThrow(/empty drawing buffer/);
  });

  it("rejects an overlay whose visible pixels have not been acknowledged for its current sample", () => {
    const { root, slotB } = makeRoot();
    const overlay = slotB.querySelector('[data-planar-overlay-layer="vectors"]') as HTMLCanvasElement;
    overlay.dataset.planarOverlayRenderedCurrent = "false";

    expect(() => resolveVisibleFieldMapCapture(root)).toThrow(/not current/);
  });

  it("rejects loading or stale evidence rather than exporting a retained raster", () => {
    const { root } = makeRoot();
    const output = root.querySelector('[aria-label="Planar field evidence"]')!;
    for (const status of ["loading", "stale"] as const) {
      output.dataset.planarStatus = status;
      output.dataset.planarEvidence = JSON.stringify({ ...makeEvidence(), status });
      expect(() => resolveVisibleFieldMapCapture(root)).toThrow(/not current/);
    }
  });
});
