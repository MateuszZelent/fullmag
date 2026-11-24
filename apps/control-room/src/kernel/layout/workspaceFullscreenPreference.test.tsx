import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getBottomDockExpanded,
  setBottomDockExpanded,
} from "./bottomDockPreference";
import { LayoutController } from "./LayoutController";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { SHELL_COMMANDS } from "./shellCommands";
import { installSimulationPreparationTestDom } from "./simulationPreparationTestDom.test-support";
import { WorkspaceFullscreenButton } from "./WorkspaceFullscreenButton";
import {
  getWorkspaceFullscreen,
  setWorkspaceFullscreen,
  subscribeWorkspaceFullscreen,
  toggleWorkspaceFullscreen,
} from "./workspaceFullscreenPreference";

describe("workspaceFullscreenPreference", () => {
  afterEach(() => {
    setWorkspaceFullscreen(false);
    setBottomDockExpanded(true, { persist: false });
  });

  it("folds the bottom dock when entering fullscreen and restores it on exit", () => {
    setBottomDockExpanded(true, { persist: false });
    const onChange = vi.fn();
    const unsubscribe = subscribeWorkspaceFullscreen(onChange);

    try {
      expect(getWorkspaceFullscreen()).toBe(false);
      expect(getBottomDockExpanded()).toBe(true);

      setWorkspaceFullscreen(true);
      expect(getWorkspaceFullscreen()).toBe(true);
      expect(getBottomDockExpanded()).toBe(false);
      expect(onChange).toHaveBeenCalledTimes(1);

      // Idempotent call keeps the original restore snapshot intact.
      setWorkspaceFullscreen(true);
      expect(onChange).toHaveBeenCalledTimes(1);

      setWorkspaceFullscreen(false);
      expect(getWorkspaceFullscreen()).toBe(false);
      expect(getBottomDockExpanded()).toBe(true);
      expect(onChange).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });

  it("preserves an already-collapsed bottom dock when exiting fullscreen", () => {
    setBottomDockExpanded(false, { persist: false });

    toggleWorkspaceFullscreen();
    expect(getWorkspaceFullscreen()).toBe(true);
    expect(getBottomDockExpanded()).toBe(false);

    toggleWorkspaceFullscreen();
    expect(getWorkspaceFullscreen()).toBe(false);
    expect(getBottomDockExpanded()).toBe(false);
  });

  it("keeps left (Model) and right (Inspector) panels full when toggled via shell command", () => {
    const bus = new EventBus<KernelEventMap>();
    const layout = new LayoutController(bus);
    const command = SHELL_COMMANDS.find(
      (entry) => entry.id === "workspace.fullscreen-toggle",
    );

    expect(command).toBeDefined();
    expect(command?.shortcut).toBe("Alt+Shift+F");
    expect(layout.get().panelVisible).toEqual({
      left: true,
      right: true,
      bottom: true,
    });

    const ctx = {
      bus,
      layout,
      source: "menu" as const,
    };

    expect(command?.isActive?.(ctx)).toBe(false);
    command?.run(ctx);
    expect(command?.isActive?.(ctx)).toBe(true);
    expect(getBottomDockExpanded()).toBe(false);
    expect(layout.get().panelVisible.left).toBe(true);
    expect(layout.get().panelVisible.right).toBe(true);

    command?.run(ctx);
    expect(command?.isActive?.(ctx)).toBe(false);
    expect(getBottomDockExpanded()).toBe(true);
    expect(layout.get().panelVisible.left).toBe(true);
    expect(layout.get().panelVisible.right).toBe(true);
  });

  it("renders an accessible toggle button with static label and live aria-pressed state", () => {
    // Server snapshot stays hydration-safe (false).
    const ssrHtml = renderToStaticMarkup(<WorkspaceFullscreenButton />);
    expect(ssrHtml).toContain('aria-label="Full screen workspace"');
    expect(ssrHtml).toContain('aria-pressed="false"');
    expect(ssrHtml).toContain('aria-hidden="true"');
    expect(ssrHtml).toContain("Alt+Shift+F");

    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    try {
      act(() => {
        root.render(<WorkspaceFullscreenButton variant="strip" />);
      });
      const button = container.querySelector<HTMLButtonElement>("button");
      expect(button?.getAttribute("aria-label")).toBe("Full screen workspace");
      expect(button?.getAttribute("aria-pressed")).toBe("false");
      expect(button?.getAttribute("data-fullscreen-variant")).toBe("strip");

      act(() => {
        button?.click();
      });
      expect(button?.getAttribute("aria-label")).toBe("Full screen workspace");
      expect(button?.getAttribute("aria-pressed")).toBe("true");
      expect(getWorkspaceFullscreen()).toBe(true);
      expect(getBottomDockExpanded()).toBe(false);

      act(() => {
        button?.click();
      });
      expect(button?.getAttribute("aria-pressed")).toBe("false");
      expect(getWorkspaceFullscreen()).toBe(false);
      expect(getBottomDockExpanded()).toBe(true);
    } finally {
      act(() => {
        root.unmount();
      });
      dom.restore();
    }
  });
});
