import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import {
  findElement,
  installSimulationPreparationTestDom,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { Viewport3DExportMenu } from "./Viewport3DExportSurface";

describe("Viewport3DExportMenu", () => {
  it.each([
    { gesture: "click", movement: 0, state: "open" },
    { gesture: "drag", movement: 12, state: "closed" },
  ])("handles a right $gesture when the camera suppresses the native context menu", async ({ movement, state }) => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    try {
      await act(async () => root.render(
        <Viewport3DExportMenu onCommand={() => undefined}>
          <div data-test-viewport=""><canvas /></div>
        </Viewport3DExportMenu>,
      ));
      const viewport = findElement(container, (el) => el.getAttribute("data-test-viewport") !== null, "viewport");
      const canvas = findElement(container, (el) => el.tagName === "CANVAS", "canvas");
      canvas.addEventListener("contextmenu", (event) => event.preventDefault());
      const pointer = (type: string, clientX: number) => Object.assign(
        new TestEvent(type, { bubbles: true }), { button: 2, buttons: 2, clientX, clientY: 40 },
      );
      await act(async () => {
        canvas.dispatchEvent(pointer("pointerdown", 40));
        canvas.dispatchEvent(pointer("pointermove", 40 + movement));
        canvas.dispatchEvent(pointer("contextmenu", 40 + movement));
      });

      expect(viewport.getAttribute("data-state")).toBe(state);
    } finally {
      await act(async () => root.unmount());
      dom.document.body.removeChild(container);
      dom.restore();
    }
  });
});
