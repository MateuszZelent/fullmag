import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  findElements,
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
  type TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { PlanarTargetFieldSection } from "./PlanarTargetFieldSection";
import { createFieldLayer, type PlanarFieldLayer, type PlanarFieldQuantityOption, type PlanarLayerState } from "./planarFieldLayers";

const masks: PlanarLayerState = {
  boundaries: false, bounds: false, contours: false, mesh: true, points: false,
  probes: true, raster: true, streamlines: false, vectors: false,
};
const quantities: PlanarFieldQuantityOption[] = [
  { id: "m", label: "Magnetization", unit: "1", vector: true, components: [
    { value: "magnitude", label: "magnitude" }, { value: "x", label: "x" },
  ] },
  { id: "E_density", label: "Energy density", unit: "J/m3", vector: false, components: [
    { value: "magnitude", label: "magnitude", outputKind: "scalar" },
  ] },
  { id: "H_demag", label: "Demagnetizing field", unit: "A/m", vector: true, components: [
    { value: "magnitude", label: "magnitude" },
  ] },
];
const film = createFieldLayer({ id: "object:film", kind: "object" });

function render(layer: PlanarFieldLayer | null, onWrite = vi.fn(), extra: Partial<Parameters<typeof PlanarTargetFieldSection>[0]> = {}) {
  return (
    <PlanarTargetFieldSection
      layer={layer}
      layers={layer ? [layer] : []}
      quantities={quantities}
      targetLabel="film"
      viewMasks={masks}
      onAdd={vi.fn()}
      onWrite={onWrite}
      {...extra}
    />
  );
}

async function mount(node: ReturnType<typeof render>) {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(node));
  return { container, unmount: async () => { await act(async () => root.unmount()); dom.restore(); } };
}

function control(root: TestNode, label: string): TestElement {
  const element = findElements(root, (candidate) => candidate.getAttribute("aria-label") === label)[0];
  if (!element) throw new Error(`Missing ${label}`);
  return element;
}

function change(element: TestElement, value: string): void {
  const tracker = (element as TestElement & { _valueTracker?: { setValue: (next: string) => void } })._valueTracker;
  const previous = element.value;
  element.value = value;
  tracker?.setValue(previous);
  element.dispatchEvent(new TestEvent("change", { bubbles: true }));
}

function button(root: TestNode, text: string): TestElement {
  const element = findElements(root, (candidate) => candidate.tagName === "BUTTON" && candidate.textContent === text)[0];
  if (!element) throw new Error(`Missing button ${text}`);
  return element;
}

const filmCandidate = { id: "object:film", label: "film", target: { id: "object:film", kind: "object" as const } };

describe("PlanarTargetFieldSection", () => {
  it("shows Color and Arrows directly and keeps the other passes under More drawing", () => {
    const html = renderToStaticMarkup(render({ ...film, vectors_visible: true, mesh_visible: true }));
    expect(html).toContain("Field in film");
    expect(html).toContain("Own setting · Magnetization · direction");
    for (const pass of ["Color", "Arrows", "Points", "Mesh", "Contours", "Streamlines"]) {
      expect(html).toContain(`aria-label="Toggle ${pass}"`);
    }
    expect(html.indexOf('aria-label="Toggle Arrows"')).toBeLessThan(html.indexOf("More drawing"));
    expect(html.indexOf("More drawing")).toBeLessThan(html.indexOf('aria-label="Toggle Mesh"'));
    expect(html).toMatch(/aria-label="Toggle Arrows" aria-pressed="true"[^>]*>.*?hidden in toolbar/);
    expect(html).toMatch(/aria-label="Toggle Mesh" aria-pressed="true"/);
  });

  it("disables every pass of a hidden layer and offers to show it again", async () => {
    const onWrite = vi.fn();
    const layer = { ...film, visible: false };
    expect(renderToStaticMarkup(render(layer))).toMatch(/aria-label="Toggle Color" aria-pressed="false"[^>]*disabled/);
    const view = await mount(render(layer, onWrite));
    try {
      await act(async () => button(view.container, "Show film in the 2D view").click());
      expect(onWrite).toHaveBeenCalledWith([{ ...layer, visible: true }], "object:film", undefined);
    } finally {
      await view.unmount();
    }
  });

  it("flushes a quantity change and drops vector passes of a scalar quantity", async () => {
    const onWrite = vi.fn();
    const layer = { ...film, vectors_visible: true };
    const view = await mount(render(layer, onWrite));
    try {
      await act(async () => change(control(view.container, "Quantity"), "E_density"));
      expect(onWrite).toHaveBeenCalledWith([{
        ...layer,
        quantity_id: "E_density",
        component: "magnitude",
        colormap: "viridis",
        vectors_visible: false,
        streamlines_visible: false,
      }], "object:film", { flush: true });
    } finally {
      await view.unmount();
    }
  });

  it("does not offer magnetization on an Airbox layer", () => {
    const html = renderToStaticMarkup(render(createFieldLayer({ id: "airbox", kind: "airbox" })));
    expect(html).not.toContain("Magnetization (1)");
    expect(html).toContain("Demagnetizing field (A/m)");
    expect(html).toContain("Remove from 2D view");
  });

  it("names the inherited All objects field and creates the own layer from a chosen quantity", async () => {
    const onAdd = vi.fn();
    const all = createFieldLayer("all");
    const view = await mount(render(null, vi.fn(), { emptyTarget: filmCandidate, inherited: all, layers: [all], onAdd }));
    try {
      expect(view.container.textContent).toContain("Inherited from All objects · Magnetization · direction");
      expect(view.container.textContent).not.toContain("Add field");
      await act(async () => change(control(view.container, "Quantity"), "H_demag"));
      expect(onAdd).toHaveBeenCalledWith(filmCandidate, "H_demag");
    } finally {
      await view.unmount();
    }
  });

  it("says a target without any layer is not drawn", () => {
    const airbox = { id: "airbox", label: "Airbox", target: { id: "airbox", kind: "airbox" as const } };
    const html = renderToStaticMarkup(render(null, vi.fn(), { emptyTarget: airbox }));
    expect(html).toContain("Not drawn in the 2D view");
    expect(html).not.toContain("Magnetization (1)");
  });

  it("returns an object to the All objects setting by removing its own layer", async () => {
    const onWrite = vi.fn();
    const all = createFieldLayer("all");
    const view = await mount(render(film, onWrite, { layers: [film, all] }));
    try {
      await act(async () => button(view.container, "Use All objects setting").click());
      expect(onWrite).toHaveBeenCalledWith([all], "object:film", { flush: true });
    } finally {
      await view.unmount();
    }
  });
});
