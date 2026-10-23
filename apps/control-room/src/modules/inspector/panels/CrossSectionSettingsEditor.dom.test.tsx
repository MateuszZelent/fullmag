import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { QuantityFieldDraftScope } from "../primitives/QuantityField";
import { createQuantityFieldDraftStore } from "../primitives/quantityFieldDraftStore";
import type { CrossSectionDraft } from "@/kernel/workspace/crossSectionWorkspace";

import { CrossSectionSettingsEditor } from "./CrossSectionSettingsEditor";

const value: CrossSectionDraft = {
  colorScale: "viridis",
  edgeWidth: 1.5,
  filterExpression: "quality < 0.3",
  frameExtent: "universe",
  id: "draft",
  includeWireframe: true,
  metric: "skewness",
  name: "Draft cross-section",
  plane: "xy",
  positionPercent: 50,
  rotationDegrees: 0,
  shrinkFactor: 0.8,
};

describe("CrossSectionSettingsEditor numeric drafts", () => {
  it("keeps incomplete and valid raw text until explicit Enter commit", async () => {
    const mounted = await mountEditor();
    try {
      const position = findInput(mounted.container, "Position");
      for (const rawText of ["", "-", "12."]) {
        await act(async () => editInput(position, rawText));
        expect(position.value).toBe(rawText);
        expect(mounted.onChange).not.toHaveBeenCalled();
        expect(mounted.draftStore.getSummary().pendingCount).toBe(1);
      }

      await act(async () => {
        position.dispatchEvent(new TestEvent("keydown", { bubbles: true, key: "Enter" }));
      });
      expect(mounted.onChange).toHaveBeenCalledWith({ positionPercent: 12 });
      expect(mounted.draftStore.getSummary().pendingCount).toBe(0);
    } finally {
      await mounted.unmount();
    }
  });

  it("commits legal zero, negative and boundary values after blur or Enter", async () => {
    const mounted = await mountEditor();
    try {
      const position = findInput(mounted.container, "Position");
      await act(async () => {
        editInput(position, "0");
        position.dispatchEvent(new TestEvent("focusout", { bubbles: true }));
      });

      const rotation = findInput(mounted.container, "Rotation");
      await act(async () => {
        editInput(rotation, "-180");
        rotation.dispatchEvent(new TestEvent("keydown", { bubbles: true, key: "Enter" }));
      });

      const edgeWidth = findInput(mounted.container, "Edge width");
      await act(async () => {
        editInput(edgeWidth, "0.5");
        edgeWidth.dispatchEvent(new TestEvent("focusout", { bubbles: true }));
      });

      const shrink = findInput(mounted.container, "Shrink");
      await act(async () => {
        editInput(shrink, "1");
        shrink.dispatchEvent(new TestEvent("keydown", { bubbles: true, key: "Enter" }));
      });

      expect(mounted.onChange.mock.calls).toEqual([
        [{ positionPercent: 0 }],
        [{ rotationDegrees: -180 }],
        [{ edgeWidth: 0.5 }],
        [{ shrinkFactor: 1 }],
      ]);
      expect(mounted.draftStore.getSummary().pendingCount).toBe(0);
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps out-of-range values raw and does not commit them", async () => {
    const mounted = await mountEditor();
    try {
      const edgeWidth = findInput(mounted.container, "Edge width");
      await act(async () => {
        editInput(edgeWidth, "4.01");
        edgeWidth.dispatchEvent(new TestEvent("keydown", { bubbles: true, key: "Enter" }));
      });

      expect(edgeWidth.value).toBe("4.01");
      expect(mounted.onChange).not.toHaveBeenCalled();
      expect(mounted.draftStore.getSummary().invalidLabels).toEqual(["Edge width"]);

      await act(async () => {
        editInput(edgeWidth, "1e999");
        edgeWidth.dispatchEvent(new TestEvent("keydown", { bubbles: true, key: "Enter" }));
      });
      expect(edgeWidth.value).toBe("1e999");
      expect(mounted.onChange).not.toHaveBeenCalled();

      await act(async () => {
        editInput(edgeWidth, "4");
        edgeWidth.dispatchEvent(new TestEvent("focusout", { bubbles: true }));
      });
      expect(mounted.onChange).toHaveBeenCalledWith({ edgeWidth: 4 });
      expect(mounted.draftStore.getSummary().pendingCount).toBe(0);
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps sliders immediate and clears only raw text for the same quantity", async () => {
    const mounted = await mountEditor();
    try {
      const position = findInput(mounted.container, "Position");
      const edgeWidth = findInput(mounted.container, "Edge width");
      await act(async () => {
        editInput(position, "12.");
        editInput(edgeWidth, "5");
      });

      const positionSlider = findInput(mounted.container, "Position slider");
      await act(async () => {
        // A browser changes the native value before dispatching input. Bypass
        // React's instance setter so its change tracker observes that change.
        const setNativeValue = Object.getOwnPropertyDescriptor(TestElement.prototype, "value")?.set;
        if (!setNativeValue) throw new Error("Missing native input value setter");
        setNativeValue.call(positionSlider, "25");
        positionSlider.dispatchEvent(new TestEvent("input", { bubbles: true }));
      });

      expect(mounted.onChange).toHaveBeenCalledWith({ positionPercent: 25 });
      expect(mounted.draftStore.getSummary().pendingCount).toBe(1);
      expect(mounted.draftStore.getSummary().invalidLabels).toEqual(["Edge width"]);
      expect(edgeWidth.value).toBe("5");
    } finally {
      await mounted.unmount();
    }
  });
});

async function mountEditor() {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  const draftStore = createQuantityFieldDraftStore();
  const onChange = vi.fn();
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(
      <QuantityFieldDraftScope store={draftStore}>
        <CrossSectionSettingsEditor action={null} onChange={onChange} value={value} />
      </QuantityFieldDraftScope>,
    );
  });

  return {
    container,
    draftStore,
    onChange,
    unmount: async () => {
      await act(async () => root.unmount());
      dom.restore();
    },
  };
}

function findInput(root: TestNode, label: string): TestElement {
  const input = findElements(
    root,
    (element) =>
      element.tagName === "INPUT" && element.getAttribute("aria-label") === label,
  )[0];
  if (!input) throw new Error(`Missing input ${label}`);
  return input;
}

function editInput(input: TestElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new TestEvent("input", { bubbles: true }));
}

function findElements(
  root: TestNode,
  predicate: (element: TestElement) => boolean,
): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode): void => {
    if (node instanceof TestElement && predicate(node)) found.push(node);
    node.childNodes.forEach(visit);
  };
  visit(root);
  return found;
}
