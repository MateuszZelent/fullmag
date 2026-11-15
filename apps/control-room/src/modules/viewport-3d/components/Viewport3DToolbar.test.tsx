import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  findElement,
  installSimulationPreparationTestDom,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { Viewport3DToolbar } from "./Viewport3DToolbar";

function createProps(onCommand: (id: string) => void) {
  return {
    inspectEnabled: false,
    layersContent: <div>Vector overlays</div>,
    onCommand,
    projection: "perspective" as const,
    qualityProfileId: "balanced" as const,
    settingsOpen: false,
  };
}

function click(element: ReturnType<typeof findElement>) {
  element.dispatchEvent(new TestEvent("click", { bubbles: true }));
}

describe("Viewport3DToolbar", () => {
  it("renders named action groups and keeps explained fit unavailable but reachable", () => {
    const html = renderToStaticMarkup(
      <Viewport3DToolbar
        {...createProps(() => undefined)}
        fitDisabledReason="The current scene has no visible bounds."
        inspectEnabled
        settingsOpen
      />,
    );

    expect(html).toContain('aria-label="3D view tools"');
    expect(html).toMatch(/role="toolbar"/);
    for (const group of ["Navigation", "Projection", "Inspection", "Layers", "Quality", "Export", "Settings"]) {
      expect(html).toContain(`aria-label="${group}"`);
    }
    expect(html).toContain('aria-label="Fit view"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("The current scene has no visible bounds.");
    expect(html).toContain('aria-label="Projection"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-label="Inspect values"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="View settings"');
    expect(html).not.toMatch(/<button[^>]*aria-label="Fit view"[^>]*disabled=/);
  });

  it("routes direct actions and does not run fit while it is aria-disabled", async () => {
    const onCommand = vi.fn<(id: string) => void>();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root: Root = createRoot(container as unknown as Element);

    try {
      await act(async () => root.render(
        <Viewport3DToolbar
          {...createProps(onCommand)}
          fitDisabledReason="Wait for scene bounds."
        />,
      ));

      const fit = findElement(container, (element) => element.getAttribute("aria-label") === "Fit view", "fit view");
      expect(fit.getAttribute("aria-disabled")).toBe("true");
      await act(async () => click(fit));

      await act(async () => click(findElement(container, (element) => element.tagName === "BUTTON" && element.getAttribute("aria-label") === "Projection", "projection")));
      await act(async () => click(findElement(container, (element) => element.getAttribute("aria-label") === "Inspect values", "inspect values")));
      await act(async () => click(findElement(container, (element) => element.getAttribute("aria-label") === "Export PNG", "export PNG")));
      await act(async () => click(findElement(container, (element) => element.getAttribute("aria-label") === "View settings", "view settings")));

      expect(onCommand.mock.calls).toEqual([
        ["view-projection"],
        ["viewport-3d.inspect-toggle"],
        ["viewport-3d.capture-frame"],
        ["viewport-3d.toggle-settings"],
      ]);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
