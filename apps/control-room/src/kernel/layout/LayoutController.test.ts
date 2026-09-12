import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";

import { LayoutController } from "./LayoutController";

function setup() {
  const bus = new EventBus<KernelEventMap>();
  const controller = new LayoutController(bus);
  return { bus, controller };
}

describe("LayoutController", () => {
  it("starts with home tab and all panels visible", () => {
    const { controller } = setup();
    const state = controller.get();
    expect(state.activeModuleTab).toBe("home");
    expect(state.activeBottomPanelTab).toBe("telemetry");
    expect(state.activeViewportMainModuleId).toBe("viewport-3d");
    expect(state.panelVisible).toEqual({ left: true, right: true, bottom: true });
    expect(state.focusedSlot).toBeNull();
  });

  it("opens a requested bottom tab in one durable layout transaction", () => {
    const { bus, controller } = setup();
    const layoutListener = vi.fn();
    const focusListener = vi.fn();
    bus.on("workspace:layout-changed", layoutListener);
    bus.on("workspace:focus-changed", focusListener);
    controller.setPanelVisible("bottom", false);
    layoutListener.mockClear();

    controller.openBottomPanel("diagnostics");

    expect(controller.get()).toMatchObject({
      activeBottomPanelTab: "diagnostics",
      focusedSlot: "panel-bottom",
      panelVisible: { bottom: true },
    });
    expect(layoutListener).toHaveBeenCalledTimes(1);
    expect(focusListener).toHaveBeenCalledTimes(1);
  });

  it("opens Quick Chart without changing the active spatial viewport", () => {
    const { controller } = setup();
    controller.setActiveViewportMainModule("field-map");

    controller.openBottomPanel("quick-chart");

    expect(controller.get()).toMatchObject({
      activeBottomPanelTab: "quick-chart",
      activeViewportMainModuleId: "field-map",
      focusedSlot: "panel-bottom",
      panelVisible: { bottom: true },
    });
  });

  it("setActiveTab() changes tab and emits layout-changed", () => {
    const { bus, controller } = setup();
    const listener = vi.fn();
    bus.on("workspace:layout-changed", listener);

    controller.setActiveTab("mesh");
    expect(controller.get().activeModuleTab).toBe("mesh");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("applies the kernel-owned frequency-domain Results preset without a second shell", () => {
    const { controller } = setup();
    controller.setPanelVisible("left", false);
    controller.setPanelVisible("right", false);
    controller.setPanelVisible("bottom", false);

    controller.applyPreset("workspace.results.frequency-domain");

    expect(controller.get()).toMatchObject({
      activeModuleTab: "results",
      activeViewportMainModuleId: "analysis-plots",
      focusedSlot: "panel-left",
      panelVisible: { left: true, right: true, bottom: true },
    });
  });

  it("setActiveViewportMainModule() changes center viewport surface and emits layout-changed", () => {
    const { bus, controller } = setup();
    const listener = vi.fn();
    bus.on("workspace:layout-changed", listener);

    controller.setActiveViewportMainModule("cross-section-image");
    expect(controller.get().activeViewportMainModuleId).toBe("cross-section-image");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("preserves the last spatial viewport while analysis is active", () => {
    const { controller } = setup();

    controller.setActiveViewportMainModule("field-map");
    controller.setActiveViewportMainModule("analysis-plots");

    expect(controller.get()).toMatchObject({
      activeViewportMainModuleId: "analysis-plots",
      lastSpatialViewportMainModuleId: "field-map",
    });
  });

  it("setActiveTab() does not emit for same tab", () => {
    const { bus, controller } = setup();
    const listener = vi.fn();
    bus.on("workspace:layout-changed", listener);

    controller.setActiveTab("home");
    expect(listener).not.toHaveBeenCalled();
  });

  it("togglePanel() flips visibility", () => {
    const { controller } = setup();
    expect(controller.get().panelVisible.left).toBe(true);

    controller.togglePanel("left");
    expect(controller.get().panelVisible.left).toBe(false);

    controller.togglePanel("left");
    expect(controller.get().panelVisible.left).toBe(true);
  });

  it("setPanelVisible() sets exact value", () => {
    const { controller } = setup();
    controller.setPanelVisible("bottom", false);
    expect(controller.get().panelVisible.bottom).toBe(false);
  });

  it("setFocusedSlot() emits focus-changed", () => {
    const { bus, controller } = setup();
    const listener = vi.fn();
    bus.on("workspace:focus-changed", listener);

    controller.setFocusedSlot("viewport-main");
    expect(controller.get().focusedSlot).toBe("viewport-main");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("preserves panelVisible identity for selector hooks on focus-only changes", () => {
    const { controller } = setup();
    const panelVisible = controller.get().panelVisible;

    controller.setFocusedSlot("viewport-main");
    expect(controller.get().panelVisible).toBe(panelVisible);

    controller.setActiveViewportMainModule("analysis-plots");
    expect(controller.get().panelVisible).toBe(panelVisible);

    controller.setActiveTab("study");
    expect(controller.get().panelVisible).toBe(panelVisible);

    controller.togglePanel("left");
    expect(controller.get().panelVisible).not.toBe(panelVisible);
  });

  it("subscribe() receives changes and can unsubscribe", () => {
    const { controller } = setup();
    const listener = vi.fn();
    const unsub = controller.subscribe(listener);

    controller.setActiveTab("study");
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    controller.setActiveTab("results");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
