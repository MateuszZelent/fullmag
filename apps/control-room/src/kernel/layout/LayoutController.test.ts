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
    expect(state.activeViewportMainModuleId).toBe("viewport-3d");
    expect(state.panelVisible).toEqual({ left: true, right: true, bottom: true });
    expect(state.focusedSlot).toBeNull();
  });

  it("setActiveTab() changes tab and emits layout-changed", () => {
    const { bus, controller } = setup();
    const listener = vi.fn();
    bus.on("workspace:layout-changed", listener);

    controller.setActiveTab("mesh");
    expect(controller.get().activeModuleTab).toBe("mesh");
    expect(listener).toHaveBeenCalledTimes(1);
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
