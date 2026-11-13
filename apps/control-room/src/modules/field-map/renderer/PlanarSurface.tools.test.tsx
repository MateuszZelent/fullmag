import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  findElement,
  installSimulationPreparationTestDom,
  TestEvent,
  type TestElement,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { planarToolStore } from "@/kernel/visualization/planarToolStore";

import { buildFieldMapRenderModel } from "../model/fieldMapRenderModel";
import { PlanarSurface } from "./PlanarSurface";

/** A 100 × 100 px canvas over a 1 m × 1 m frame without raster work. */
async function mountSurface(props: Partial<Parameters<typeof PlanarSurface>[0]> = {}) {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  const root = createRoot(container as unknown as Element);
  const context = {
    beginPath: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(), lineTo: vi.fn(), moveTo: vi.fn(),
    restore: vi.fn(), save: vi.fn(), scale: vi.fn(), setLineDash: vi.fn(), stroke: vi.fn(), translate: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  const createElement = dom.document.createElement.bind(dom.document);
  dom.document.createElement = ((tag: string) => {
    const element = createElement(tag);
    if (tag.toLowerCase() === "canvas") Object.assign(element, { getContext: () => context, height: 0, width: 0 });
    return element;
  }) as typeof dom.document.createElement;
  const model = buildFieldMapRenderModel({
    bounds: [0, 1, 0, 1], canonicalUnit: "A/m", component: "normal",
    frame: { normal: [0, 0, 1], origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 1, 0] },
    layers: { contours: false, mesh: false, probes: false, raster: false, vectors: false },
    range: { mode: "auto" }, resolution: [1, 1], sampleIdentity: "tools", scalar: new Float64Array([1]),
  });
  await act(async () => { root.render(<PlanarSurface model={model} {...props} />); });
  const canvas = findElement(container, (element) => element.getAttribute("aria-label") === "Planar scalar field", "canvas");
  Object.assign(canvas, {
    clientHeight: 100,
    clientWidth: 100,
    hasPointerCapture: vi.fn(() => true),
    releasePointerCapture: vi.fn(),
    setPointerCapture: vi.fn(),
  });
  return {
    canvas,
    async unmount() {
      await act(async () => root.unmount());
      dom.restore();
    },
  };
}

function pointer(type: string, x: number, y: number, extra: Record<string, unknown> = {}) {
  const event = new TestEvent(type, { bubbles: true });
  Object.assign(event, { clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", ...extra });
  return event;
}

async function drag(canvas: TestElement, from: [number, number], to: [number, number], extra: Record<string, unknown> = {}) {
  await act(async () => {
    canvas.dispatchEvent(pointer("pointerdown", from[0], from[1], extra));
    canvas.dispatchEvent(pointer("pointermove", to[0], to[1], extra));
    canvas.dispatchEvent(pointer("pointerup", to[0], to[1], extra));
  });
}

describe("PlanarSurface canvas tools", () => {
  afterEach(() => planarToolStore.reset());

  it("zoom-box: a drag below 4 px sends nothing; a box sends one interaction on release and returns to navigate", async () => {
    const onInteraction = vi.fn();
    planarToolStore.setActiveTool("zoom-box");
    const surface = await mountSurface({ onInteraction });
    try {
      await drag(surface.canvas, [10, 10], [13, 60]);
      expect(onInteraction).not.toHaveBeenCalled();
      expect(planarToolStore.getSnapshot().activeTool).toBe("zoom-box");

      await drag(surface.canvas, [25, 25], [75, 75]);
      expect(onInteraction).toHaveBeenCalledTimes(1);
      const interaction = onInteraction.mock.calls[0]![0] as { panU: number; panV: number; zoom: number };
      expect(interaction.zoom).toBeCloseTo(2, 12);
      expect(interaction.panU).toBeCloseTo(0, 12);
      expect(planarToolStore.getSnapshot().activeTool).toBe("navigate");
    } finally {
      await surface.unmount();
    }
  });

  it("measure: a drag records the ruler and Escape clears it", async () => {
    planarToolStore.setActiveTool("measure");
    const surface = await mountSurface();
    try {
      await drag(surface.canvas, [0, 100], [30, 60]);
      expect(planarToolStore.getSnapshot().measure).toEqual({ u0_m: 0, u1_m: 0.3, v0_m: 0, v1_m: 0.4 });
      await act(async () => { surface.canvas.dispatchEvent(new TestEvent("keydown", { bubbles: true, key: "Escape" })); });
      expect(planarToolStore.getSnapshot().measure).toBeNull();
      expect(planarToolStore.getSnapshot().activeTool).toBe("measure");
    } finally {
      await surface.unmount();
    }
  });

  it("crop: Enter commits once, clipped to the full frame; Escape cancels without a commit", async () => {
    const onCropCommit = vi.fn();
    planarToolStore.setActiveTool("crop");
    const surface = await mountSurface({ cropFullBounds: [0, 0.5, 0, 1], onCropCommit });
    try {
      await drag(surface.canvas, [25, 75], [75, 25]);
      expect(planarToolStore.getSnapshot().cropDraft).toEqual({ u_min_m: 0.25, u_max_m: 0.75, v_min_m: 0.25, v_max_m: 0.75 });
      await act(async () => { surface.canvas.dispatchEvent(new TestEvent("keydown", { bubbles: true, key: "Enter" })); });
      expect(onCropCommit).toHaveBeenCalledExactlyOnceWith({ u_min_m: 0.25, u_max_m: 0.5, v_min_m: 0.25, v_max_m: 0.75 });
      expect(planarToolStore.getSnapshot().cropDraft).toBeNull();

      planarToolStore.setActiveTool("crop");
      await drag(surface.canvas, [20, 80], [40, 60]);
      await act(async () => { surface.canvas.dispatchEvent(new TestEvent("keydown", { bubbles: true, key: "Escape" })); });
      expect(planarToolStore.getSnapshot().cropDraft).toBeNull();
      expect(onCropCommit).toHaveBeenCalledTimes(1);

      // Below 4 px the draft is dropped and Enter has nothing to commit.
      await drag(surface.canvas, [20, 80], [22, 60]);
      await act(async () => { surface.canvas.dispatchEvent(new TestEvent("keydown", { bubbles: true, key: "Enter" })); });
      expect(onCropCommit).toHaveBeenCalledTimes(1);
    } finally {
      await surface.unmount();
    }
  });

  it("Shift + drag still draws a line profile in a box tool", async () => {
    const onProfileSegment = vi.fn();
    const onInteraction = vi.fn();
    planarToolStore.setActiveTool("zoom-box");
    const surface = await mountSurface({ onInteraction, onProfileSegment });
    try {
      await drag(surface.canvas, [10, 50], [90, 50], { shiftKey: true });
      expect(onProfileSegment).toHaveBeenCalledExactlyOnceWith({ u0: 0.1, u1: 0.9, v0: 0.5, v1: 0.5 });
      expect(onInteraction).not.toHaveBeenCalled();
    } finally {
      await surface.unmount();
    }
  });

  it("inspect: a click pins the point even with the probes mask off", async () => {
    const onPin = vi.fn();
    planarToolStore.setActiveTool("inspect");
    const surface = await mountSurface({ onPin });
    try {
      await act(async () => { surface.canvas.dispatchEvent(pointer("click", 25, 75)); });
      expect(onPin).toHaveBeenCalledExactlyOnceWith(0.25, 0.25);
    } finally {
      await surface.unmount();
    }
  });

  it("wheel zooms in every tool", async () => {
    const onInteraction = vi.fn();
    planarToolStore.setActiveTool("crop");
    const surface = await mountSurface({ onInteraction });
    try {
      await act(async () => { surface.canvas.dispatchEvent(pointer("wheel", 50, 50, { deltaY: -100 })); });
      expect(onInteraction).toHaveBeenCalledTimes(1);
      expect((onInteraction.mock.calls[0]![0] as { zoom: number }).zoom).toBeGreaterThan(1);
    } finally {
      await surface.unmount();
    }
  });
});
