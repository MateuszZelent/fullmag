import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { primitiveDraftOverlayStore } from "@/kernel/authoring/geometryLifecycleCommands";
import {
  installSimulationPreparationTestDom,
  TestElement,
  type TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { usePrimitiveDraftOverlay } from "./usePrimitiveDraftOverlay";

function Probe() {
  const overlay = usePrimitiveDraftOverlay();
  return <div data-geometry-key={overlay?.geometryKey ?? "none"} />;
}

describe("usePrimitiveDraftOverlay", () => {
  afterEach(() => primitiveDraftOverlayStore.clear());

  it("reacts to the local draft store without requesting mesh data", async () => {
    const meshRequest = vi.fn();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<Probe />));
      expect(probe(container).getAttribute("data-geometry-key")).toBe("none");

      await act(async () =>
        primitiveDraftOverlayStore.publish({
          dimensions: [2e-7, 4e-7, 6e-8],
          errors: {},
          kind: "Box",
          translation: [7e-9, 8e-9, 9e-9],
        }),
      );

      expect(probe(container).getAttribute("data-geometry-key")).toBe(
        "draft:Box:2e-7,4e-7,6e-8:7e-9,8e-9,9e-9",
      );
      expect(meshRequest).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

function probe(root: TestNode): TestElement {
  const found = root.childNodes.find(
    (node): node is TestElement => node instanceof TestElement,
  );
  if (!found) throw new Error("Missing overlay probe");
  return found;
}
