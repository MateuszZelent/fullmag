import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import {
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { PlanarTargetFieldSection } from "./PlanarTargetFieldSection";
import {
  createPlanarTargetFieldProfile,
  planarAirboxEnablePatch,
  type PlanarTargetFieldProfile,
  type PlanarTargetFieldQuantityOption,
} from "./planarTargetFieldProfile";

type Planar = NonNullable<VisualizationStateResource["planar"]>;
type PlanarWithOverlays = Planar & { field_overlays?: PlanarTargetFieldProfile[] };

const vectorStyle: Planar["vector_style"] = {
  color_mode: "orientation",
  length_mode: "uniform",
  monochrome_color: "#cdd6f4",
  opacity: 1,
  scale: 1,
  thickness: 1,
};

const quantities: PlanarTargetFieldQuantityOption[] = [
  {
    id: "m",
    label: "Magnetization",
    unit: "1",
    vector: true,
    components: [
      { value: "magnitude", label: "magnitude" },
      { value: "x", label: "x" },
      { value: "y", label: "y" },
      { value: "z", label: "z" },
    ],
  },
  {
    id: "H_demag",
    label: "Demagnetizing field",
    unit: "A/m",
    vector: true,
    components: [{ value: "magnitude", label: "magnitude" }],
  },
];

function basePlanar(overrides: Partial<Planar> = {}): PlanarWithOverlays {
  return {
    visible: true,
    colormap: "viridis",
    component: "magnitude",
    display_unit: "A/m",
    layers: {
      boundaries: true,
      bounds: false,
      contours: false,
      mesh: true,
      points: false,
      probes: true,
      raster: true,
      vectors: false,
    },
    quantity_id: "m",
    source: { kind: "monitor", monitor_id: "plane-1" },
    default_slice: {
      operator: { kind: "plane_sample" },
      plane: "xy",
      position_fraction: 0.5,
    },
    range: { mode: "auto", min: null, max: null },
    raster_opacity: 1,
    viewport_colorbar_visible: true,
    wireframe_style: { color: "#94a3b8", opacity: 1 },
    target_overrides: [],
    point_style: { color: "#89b4fa", opacity: 1, size: 3 },
    interaction: { pan_u_m: 0, pan_v_m: 0, zoom: 1 },
    quality: "interactive",
    resolution: { height: 256, vector_budget: 512, width: 512 },
    vector_style: { ...vectorStyle },
    view_scope: { kind: "monitor_target" },
    multislice: { enabled: true, position_fractions: [0.25, 0.5, 0.75] },
    ...overrides,
  } as PlanarWithOverlays;
}

function findControl(root: TestNode, label: string): TestElement {
  const control = findElements(root, (element) => element.getAttribute("aria-label") === label)[0];
  if (!control) throw new Error(`Missing control ${label}`);
  return control;
}

function change(element: TestElement, value: string): void {
  const tracker = (element as TestElement & {
    _valueTracker?: { setValue: (next: string) => void };
  })._valueTracker;
  const previous = element.value;
  element.value = value;
  tracker?.setValue(previous);
  element.dispatchEvent(new TestEvent(
    element.tagName === "INPUT" ? "input" : "change",
    { bubbles: true },
  ));
}

function clickControl(root: TestNode, label: string): void {
  const button = findElements(
    root,
    (element) => element.tagName === "BUTTON" && element.getAttribute("aria-label") === label,
  )[0];
  if (!button) throw new Error(`Missing button ${label}`);
  button.click();
}

function clickButton(root: TestNode, label: string): void {
  const button = findElements(
    root,
    (element) => element.tagName === "BUTTON" && element.textContent === label,
  )[0];
  if (!button) throw new Error(`Missing button ${label}`);
  button.click();
}

function findElements(root: TestNode, predicate: (element: TestElement) => boolean): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode) => {
    if (node instanceof TestElement && predicate(node)) found.push(node);
    node.childNodes.forEach(visit);
  };
  visit(root);
  return found;
}

describe("PlanarTargetFieldSection", () => {
  it("patches only the selected object profile for palette and vector changes", async () => {
    const objectA = createPlanarTargetFieldProfile("body-a", vectorStyle);
    const objectB = createPlanarTargetFieldProfile("body-b", { ...vectorStyle, scale: 2 });
    const onPatch = vi.fn();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <PlanarTargetFieldSection
          target={{ id: "object:body-a", kind: "object", label: "Body A" }}
          planar={basePlanar({ field_overlays: [objectA, objectB] })}
          quantities={quantities}
          onPatch={onPatch}
        />,
      ));
      expect(container.textContent).toContain("Body A");
      await act(async () => change(findControl(container, "Color map"), "inferno"));
      expect(onPatch).toHaveBeenLastCalledWith({
        field_overlays: [
          { ...objectA, colormap: "inferno" },
          objectB,
        ],
      }, objectA.id);
      await act(async () => clickControl(container, "Toggle Vectors"));
      expect(onPatch).toHaveBeenLastCalledWith({
        field_overlays: [
          { ...objectA, vectors_visible: true },
          objectB,
        ],
      }, objectA.id);
      await act(async () => change(findControl(container, "Vector scale"), "1.5"));
      expect(onPatch).toHaveBeenLastCalledWith({
        field_overlays: [
          { ...objectA, vector_style: { ...objectA.vector_style, scale: 1.5 } },
          objectB,
        ],
      }, objectA.id);
      await act(async () => clickButton(container, "Hide field on target"));
      expect(onPatch).toHaveBeenLastCalledWith({
        field_overlays: [objectB],
      }, objectA.id);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("creates an Airbox base patch and keeps its source and quantity rules", async () => {
    const planar = basePlanar();
    const expected = planarAirboxEnablePatch(planar, quantities);
    const onPatch = vi.fn();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <PlanarTargetFieldSection
          target={{ id: "airbox", kind: "airbox", label: "Airbox" }}
          planar={planar}
          quantities={quantities}
          onPatch={onPatch}
        />,
      ));
      await act(async () => clickButton(container, "Show Airbox field"));
      expect(onPatch).toHaveBeenLastCalledWith(expected);
      expect(onPatch.mock.lastCall?.[0]).not.toHaveProperty("field_overlays");
      expect(expected).toMatchObject({
        source: { kind: "default" },
        view_scope: { kind: "airbox" },
      });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps a dormant target disabled with its reason visible", () => {
    const html = renderToStaticMarkup(
      <PlanarTargetFieldSection
        target={{ id: "object:missing", kind: "object", label: "Missing body" }}
        targetReason="The selected target is absent from the current visualization registry."
        planar={basePlanar()}
        quantities={quantities}
        onPatch={vi.fn()}
      />,
    );
    expect(html).toContain("The selected target is absent from the current visualization registry.");
    expect(html).toMatch(/<button(?=[^>]*disabled)[^>]*>Show field on target<\/button>/);
  });
});
