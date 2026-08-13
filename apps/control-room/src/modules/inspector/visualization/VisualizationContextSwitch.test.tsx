import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import {
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { VisualizationContextSwitchControl } from "./VisualizationContextSwitch";

const mocks = vi.hoisted(() => ({
  setActiveViewportMainModule: vi.fn(),
}));

vi.mock("@/kernel/layout/useLayout", () => ({
  useLayoutActions: () => ({
    setActiveViewportMainModule: mocks.setActiveViewportMainModule,
  }),
  useLayoutSelector: (selector: (state: unknown) => unknown) => selector({
    activeViewportMainModuleId: "viewport-3d",
    lastSpatialViewportMainModuleId: "viewport-3d",
  }),
}));

describe("VisualizationContextSwitchControl", () => {
  it("switches the shared viewport context to field-map, never a parallel viewport-2d module", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<VisualizationContextSwitchControl />));
      findButton(container, "2D").dispatchEvent(new TestEvent("click", { bubbles: true }));
      expect(mocks.setActiveViewportMainModule).toHaveBeenCalledWith("field-map");
      expect(mocks.setActiveViewportMainModule).not.toHaveBeenCalledWith("viewport-2d");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

function findButton(root: TestNode, text: string): TestElement {
  const found: TestElement[] = [];
  const visit = (node: TestNode) => {
    if (node instanceof TestElement && node.tagName === "BUTTON" && node.textContent === text) {
      found.push(node);
    }
    node.childNodes.forEach(visit);
  };
  visit(root);
  if (!found[0]) throw new Error(`Missing button ${text}`);
  return found[0];
}
