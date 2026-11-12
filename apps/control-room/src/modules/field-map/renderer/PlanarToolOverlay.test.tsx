import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  findElement,
  installSimulationPreparationTestDom,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { planarToolStore } from "@/kernel/visualization/planarToolStore";

import { PlanarNodeRing, PlanarToolOverlay } from "./PlanarToolOverlay";

const viewport = [0, 1e-7, 0, 5e-8] as const;
const nm = (metres: number) => `${Number((metres * 1e9).toFixed(3))} nm`;
const props = {
  axisLabels: { horizontal: "y", vertical: "z" },
  cropDisabledReason: null,
  formatLength: nm,
  onCropCancel: () => undefined,
  onCropCommit: () => undefined,
  viewport,
  zoomBox: null,
};

/** Client render: tool shapes come from the tool store, which SSR never reads. */
async function renderClient(element: ReactElement): Promise<string> {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => { root.render(element); });
    return container.innerHTML;
  } finally {
    await act(async () => root.unmount());
    dom.restore();
  }
}

describe("PlanarToolOverlay", () => {
  afterEach(() => planarToolStore.reset());

  it("renders nothing on the server, so hydration matches the empty tool state", () => {
    planarToolStore.setMeasure({ u0_m: 0, v0_m: 0, u1_m: 3e-9, v1_m: 4e-9 });
    expect(renderToStaticMarkup(<PlanarToolOverlay {...props} />)).toBe("");
  });

  it("renders nothing without a tool shape", () => {
    expect(renderToStaticMarkup(<PlanarToolOverlay {...props} />)).toBe("");
  });

  it("draws the crop draft with dimmed surroundings, eight handles and its size", async () => {
    planarToolStore.setActiveTool("crop");
    planarToolStore.setCropDraft({ u_min_m: 2.5e-8, u_max_m: 7.5e-8, v_min_m: 1e-8, v_max_m: 4e-8 });
    const html = await renderClient(<PlanarToolOverlay {...props} />);
    expect(html).toContain('fill-rule="evenodd"');
    expect(html.match(/data-planar-crop-handle=/g)).toHaveLength(8);
    expect(html).toContain("50 nm × 30 nm");
    expect(html).toContain('aria-label="Apply crop"');
    expect(html).toContain('aria-label="Cancel crop"');
  });

  it("keeps the apply button disabled with the reason for a too small crop", async () => {
    planarToolStore.setCropDraft({ u_min_m: 0, u_max_m: 1e-10, v_min_m: 0, v_max_m: 1e-8 });
    const html = await renderClient(
      <PlanarToolOverlay {...props} cropDisabledReason="Draw a crop of at least 4 px on each side." />,
    );
    expect(html).toMatch(/aria-label="Apply crop"[^>]*disabled=""/);
  });

  it("labels the ruler with its length, components and angle in the axis unit", async () => {
    planarToolStore.setMeasure({ u0_m: 0, v0_m: 0, u1_m: 3e-9, v1_m: 4e-9 });
    const html = await renderClient(<PlanarToolOverlay {...props} />);
    expect(html).toContain("<strong>5 nm</strong>");
    expect(html).toContain("Δy 3 nm · Δz 4 nm · 53.1°");
    planarToolStore.setMeasure(null);
    expect(await renderClient(<PlanarToolOverlay {...props} />)).toBe("");
  });

  it("draws the zoom box while it is dragged", () => {
    const html = renderToStaticMarkup(
      <PlanarToolOverlay {...props} zoomBox={{ u_min_m: 0, u_max_m: 5e-8, v_min_m: 0, v_max_m: 2.5e-8 }} />,
    );
    expect(html).toContain("data-planar-zoom-box");
    expect(html).toContain('width="50"');
  });

  it("commits and cancels the crop through its buttons", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const onCropCommit = vi.fn();
    const onCropCancel = vi.fn();
    planarToolStore.setCropDraft({ u_min_m: 2.5e-8, u_max_m: 7.5e-8, v_min_m: 1e-8, v_max_m: 4e-8 });
    try {
      await act(async () => {
        root.render(<PlanarToolOverlay {...props} onCropCancel={onCropCancel} onCropCommit={onCropCommit} />);
      });
      const apply = findElement(container, (element) => element.getAttribute("aria-label") === "Apply crop", "apply");
      const cancel = findElement(container, (element) => element.getAttribute("aria-label") === "Cancel crop", "cancel");
      await act(async () => { apply.dispatchEvent(new TestEvent("click", { bubbles: true })); });
      await act(async () => { cancel.dispatchEvent(new TestEvent("click", { bubbles: true })); });
      expect(onCropCommit).toHaveBeenCalledTimes(1);
      expect(onCropCancel).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("rings a node at its projection and dashes an off-plane node", () => {
    const html = renderToStaticMarkup(
      <PlanarNodeRing node={{ normal_offset_m: 1e-9, u_m: 5e-8, v_m: 2.5e-8 }} viewport={viewport} />,
    );
    expect(html).toContain("left:50%;top:50%");
    expect(html).toContain("fm-planar-node-ring--off-plane");
    expect(renderToStaticMarkup(
      <PlanarNodeRing node={{ normal_offset_m: 0, u_m: 2e-7, v_m: 0 }} viewport={viewport} />,
    )).toBe("");
  });
});
