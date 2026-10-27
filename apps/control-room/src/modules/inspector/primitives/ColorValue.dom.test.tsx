import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  findElement,
  installSimulationPreparationTestDom,
  TestElement,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { ColorValueField } from "./ColorValue";

describe("ColorValueField", () => {
  it("keeps the picker aligned with the swatch as the theme changes without emitting a write", async () => {
    const dom = installSimulationPreparationTestDom();
    let swatchColor = "rgb(30, 102, 245)";
    let notifyThemeChange = () => undefined;
    const disconnect = vi.fn();
    class ThemeObserver {
      constructor(callback: () => void) { notifyThemeChange = callback; }
      observe() {}
      disconnect() { disconnect(); }
    }
    Object.defineProperty(globalThis, "getComputedStyle", {
      configurable: true,
      value: () => ({ backgroundColor: swatchColor }),
    });
    Object.defineProperty(globalThis, "MutationObserver", {
      configurable: true,
      value: ThemeObserver,
    });
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const onChange = vi.fn();
    try {
      await act(async () => root.render(
        <ColorValueField label="Primitive color" value="var(--fm-accent)" onChange={onChange} />,
      ));
      const picker = findElement(container, (node): node is TestElement =>
        node instanceof TestElement && node.getAttribute("aria-label") === "Primitive color picker",
        "Primitive color picker",
      );
      expect(picker.value).toBe("#1e66f5");
      swatchColor = "rgb(137, 180, 250)";
      await act(async () => notifyThemeChange());
      expect(picker.value).toBe("#89b4fa");
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      expect(disconnect).toHaveBeenCalledOnce();
      dom.restore();
    }
  });
});
