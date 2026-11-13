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

describe("PlanarTargetFieldSection", () => {
  it("renders the six passes, with a masked pass on and noted", () => {
    const html = renderToStaticMarkup(render({ ...film, vectors_visible: true, mesh_visible: true }));
    for (const pass of ["Raster", "Vectors", "Points", "Mesh", "Contours", "Streamlines"]) {
      expect(html).toContain(`aria-label="Toggle ${pass}"`);
    }
    expect(html).toMatch(/aria-label="Toggle Vectors" aria-pressed="true"[^>]*>.*?hidden in toolbar/);
    expect(html).toMatch(/aria-label="Toggle Mesh" aria-pressed="true"/);
    expect(html).not.toMatch(/aria-label="Toggle Mesh"[^>]*>.*?hidden in toolbar<\/span><\/button><button aria-label="Toggle Contours"/);
  });

  it("disables every pass of a hidden layer and keeps its configured flags", () => {
    const html = renderToStaticMarkup(render({ ...film, visible: false }));
    expect(html).toContain("Hidden. Show the layer to change what it draws.");
    expect(html).toMatch(/aria-label="Toggle Raster" aria-pressed="false"[^>]*disabled/);
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
  });

  it("shows the empty state with one Add field action for a target without a layer", async () => {
    const onAdd = vi.fn();
    const candidate = { id: "object:film", label: "film", target: { id: "object:film", kind: "object" as const } };
    const view = await mount(render(null, vi.fn(), { emptyTarget: candidate, onAdd }));
    try {
      expect(view.container.textContent).toContain("film has no 2D field layer.");
      const add = findElements(view.container, (element) => element.tagName === "BUTTON" && element.textContent === "Add field for film")[0]!;
      await act(async () => add.click());
      expect(onAdd).toHaveBeenCalledWith(candidate);
    } finally {
      await view.unmount();
    }
  });
});
