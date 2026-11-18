import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import {
  findElements,
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
  type TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { PLANAR_FIELD_LAYERS_FULL_REASON, PlanarFieldLayerList, type PlanarFieldLayerCandidate } from "./PlanarFieldLayerList";
import { createFieldLayer, PLANAR_FIELD_LAYERS_MAX, type PlanarFieldLayer, type PlanarLayerState } from "./planarFieldLayers";

const masks: PlanarLayerState = {
  boundaries: false, bounds: false, contours: false, mesh: false, points: false,
  probes: true, raster: true, streamlines: false, vectors: false,
};
const film = createFieldLayer({ id: "object:film", kind: "object" });
const airbox = createFieldLayer({ id: "airbox", kind: "airbox" });
const all = createFieldLayer("all");
const labels: Record<string, string> = { all: "All objects", airbox: "Airbox", "object:film": "film" };

async function mount(layers: PlanarFieldLayer[], candidates: PlanarFieldLayerCandidate[] = []) {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  const root = createRoot(container as unknown as Element);
  const onWrite = vi.fn();
  const onAdd = vi.fn();
  const onSelect = vi.fn();
  await act(async () => root.render(
    <PlanarFieldLayerList
      candidates={candidates}
      layers={layers}
      selectedLayerId="object:film"
      targetLabel={(layer) => labels[layer.id] ?? layer.id}
      viewMasks={masks}
      onAdd={onAdd}
      onSelect={onSelect}
      onWrite={onWrite}
    />,
  ));
  return {
    container, onAdd, onSelect, onWrite,
    unmount: async () => { await act(async () => root.unmount()); dom.restore(); },
  };
}

function byLabel(root: TestNode, label: string): TestElement {
  const element = findElements(root, (candidate) => candidate.getAttribute("aria-label") === label)[0];
  if (!element) throw new Error(`Missing ${label}`);
  return element;
}

function row(root: TestNode, id: string): TestElement {
  const element = findElements(root, (candidate) => candidate.getAttribute("data-layer-id") === id)[0];
  if (!element) throw new Error(`Missing row ${id}`);
  return element;
}

describe("PlanarFieldLayerList", () => {
  it("labels rows as target · quantity · component and marks the selected row", async () => {
    const view = await mount([film, all]);
    try {
      expect(row(view.container, "object:film").textContent).toContain("film · m · direction");
      expect(row(view.container, "object:film").getAttribute("aria-current")).toBe("true");
      await act(async () => byLabel(view.container, "Edit All objects · m · direction").click());
      expect(view.onSelect).toHaveBeenCalledWith("all");
    } finally {
      await view.unmount();
    }
  });

  it("patches only the touched layer's visibility", async () => {
    const view = await mount([film, all]);
    try {
      await act(async () => byLabel(view.container, "Hide film").click());
      expect(view.onWrite).toHaveBeenCalledWith([{ ...film, visible: false }, all], "object:film");
    } finally {
      await view.unmount();
    }
  });

  it("reorders by dragging the handle and by Alt+Arrow keys", async () => {
    const view = await mount([film, airbox, all]);
    try {
      const handle = byLabel(view.container, "Reorder All objects. Alt+Up or Alt+Down moves the layer.");
      await act(async () => {
        handle.dispatchEvent(new TestEvent("dragstart", { bubbles: true }));
        row(view.container, "object:film").dispatchEvent(new TestEvent("drop", { bubbles: true }));
      });
      expect(view.onWrite).toHaveBeenLastCalledWith([all, film, airbox], "all");

      const keyDown = Object.assign(new TestEvent("keydown", { bubbles: true, key: "ArrowDown" }), { altKey: true });
      await act(async () => { row(view.container, "object:film").dispatchEvent(keyDown); });
      expect(view.onWrite).toHaveBeenLastCalledWith([airbox, film, all], "object:film");
      expect(keyDown.defaultPrevented).toBe(true);

      const plain = new TestEvent("keydown", { bubbles: true, key: "ArrowDown" });
      await act(async () => { row(view.container, "object:film").dispatchEvent(plain); });
      expect(view.onWrite).toHaveBeenCalledTimes(2);
    } finally {
      await view.unmount();
    }
  });

  it("shows a masked quick chip as on and toggles only the layer flag", async () => {
    const layer = { ...film, vectors_visible: true };
    const view = await mount([layer]);
    try {
      const vectors = byLabel(view.container, "Vectors for film");
      expect(vectors.getAttribute("aria-pressed")).toBe("true");
      expect(vectors.getAttribute("data-pass-state")).toBe("masked");
      expect(vectors.getAttribute("title")).toContain("hidden in the toolbar");
      await act(async () => vectors.click());
      expect(view.onWrite).toHaveBeenCalledWith([{ ...layer, vectors_visible: false }], "object:film");
    } finally {
      await view.unmount();
    }
  });

  it("lists targets without a layer and refuses the seventeenth layer with a reason", async () => {
    const candidates: PlanarFieldLayerCandidate[] = [
      { id: "airbox", label: "Airbox", target: { id: "airbox", kind: "airbox" } },
    ];
    const view = await mount([all], candidates);
    try {
      const add = findElements(view.container, (element) => element.tagName === "BUTTON" && element.textContent.trim() === "Add field")[0]!;
      await act(async () => add.click());
      const items = findElements(view.container, (element) => element.getAttribute("role") === "menuitem");
      expect(items.map((item) => item.textContent)).toEqual(["Airbox"]);
      await act(async () => items[0]!.click());
      expect(view.onAdd).toHaveBeenCalledWith(candidates[0]);
    } finally {
      await view.unmount();
    }
    const full = Array.from({ length: PLANAR_FIELD_LAYERS_MAX }, (_, index) =>
      createFieldLayer({ id: `object:body-${index}`, kind: "object" }));
    const fullView = await mount(full, candidates);
    try {
      const add = findElements(fullView.container, (element) => element.tagName === "BUTTON" && element.textContent.trim() === "Add field")[0]!;
      expect(add.disabled).toBe(false);
      await act(async () => add.click());
      expect(fullView.container.textContent).toContain(PLANAR_FIELD_LAYERS_FULL_REASON);
      expect(findElements(fullView.container, (element) => element.getAttribute("role") === "menuitem")).toHaveLength(0);
      expect(fullView.onAdd).not.toHaveBeenCalled();
    } finally {
      await fullView.unmount();
    }
  });
});
