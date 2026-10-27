import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { findElements, installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { createInspectorEditSessionStore, InspectorEditSessionProvider, type InspectorEditSession } from "./InspectorEditSession";
import { InspectorFooter } from "./InspectorFooter";

describe("InspectorFooter editing modes", () => {
  it("offers a real Apply for staged drafts and only Reset display for live preferences", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const store = createInspectorEditSessionStore();
    const owner = Symbol("test form");
    const apply = vi.fn(async () => true);
    const reset = vi.fn();
    const staged: InspectorEditSession = {
      apply, applying: false, dirty: true, mode: "staged", reset, valid: true,
    };
    const buttons = () => findElements(container, (element) => element.tagName === "BUTTON");
    try {
      store.register(owner, staged);
      await act(async () => root.render(
        <InspectorEditSessionProvider store={store}>
          <InspectorFooter focusDisabled onFocus={() => undefined} />
        </InspectorEditSessionProvider>,
      ));
      expect(container.textContent).toContain("Draft");
      expect(buttons().find((button) => button.textContent.includes("Apply"))?.disabled).toBe(false);
      await act(async () => buttons().find((button) => button.textContent.includes("Apply"))!.click());
      expect(apply).toHaveBeenCalledOnce();

      await act(async () => store.update(owner, { ...staged, mode: "liveViewport" }));
      expect(container.textContent).toContain("Live");
      expect(container.textContent).toContain("Display changes apply immediately");
      expect(buttons().some((button) => button.textContent.includes("Apply"))).toBe(false);
      await act(async () => buttons().find((button) => button.textContent.includes("Reset display"))!.click());
      expect(reset).toHaveBeenCalledOnce();
      expect(apply).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps an invalid or blocked draft from invoking Apply", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const store = createInspectorEditSessionStore();
    const owner = Symbol("test form");
    const apply = vi.fn(async () => true);
    const session: InspectorEditSession = {
      apply, applying: false, dirty: true, mode: "staged", reset: vi.fn(), valid: false,
    };
    const applyButton = () => findElements(container, (element) =>
      element.tagName === "BUTTON" && element.textContent.includes("Apply"))[0];
    try {
      store.register(owner, session);
      await act(async () => root.render(
        <InspectorEditSessionProvider store={store}>
          <InspectorFooter focusDisabled onFocus={() => undefined} />
        </InspectorEditSessionProvider>,
      ));
      expect(applyButton().disabled).toBe(true);
      expect(container.textContent).toContain("Resolve validation errors before applying");
      await act(async () => store.update(owner, { ...session, valid: true, applyBlockReason: "Resolve the conflict first" }));
      expect(applyButton().disabled).toBe(true);
      expect(container.textContent).toContain("Resolve the conflict first");
      expect(apply).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
