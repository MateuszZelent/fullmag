import { describe, expect, it, vi } from "vitest";

import { MODEL_SCENE_PATH, SESSION_CURRENT_PATH } from "../api/apiPaths";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";

import { ResourceInvalidationController } from "./ResourceInvalidationController";

describe("ResourceInvalidationController", () => {
  it("tracks resource revisions and emits invalidation events", () => {
    const bus = new EventBus<KernelEventMap>();
    const controller = new ResourceInvalidationController(bus);
    const eventListener = vi.fn();
    const resourceListener = vi.fn();

    bus.on("resource:invalidated", eventListener);
    controller.subscribe("session:status", resourceListener);

    controller.invalidate("session:status", 3);

    expect(controller.getRevision("session:status")).toBe(3);
    expect(resourceListener).toHaveBeenCalledWith(3);
    expect(eventListener).toHaveBeenCalledWith({
      resourceKey: "session:status",
      revision: 3,
    });
  });

  it("does not notify subscribers for duplicate resource revisions", () => {
    const bus = new EventBus<KernelEventMap>();
    const controller = new ResourceInvalidationController(bus);
    const eventListener = vi.fn();
    const resourceListener = vi.fn();

    bus.on("resource:invalidated", eventListener);
    controller.subscribe("session:status", resourceListener);

    controller.invalidate("session:status", 3);
    controller.invalidate("session:status", 3);
    controller.invalidate("session:status", 4);

    expect(resourceListener).toHaveBeenCalledTimes(2);
    expect(eventListener).toHaveBeenCalledTimes(2);
    expect(controller.getRevision("session:status")).toBe(4);
  });

  it("does not move numeric resource revisions backwards", () => {
    const bus = new EventBus<KernelEventMap>();
    const controller = new ResourceInvalidationController(bus);
    const eventListener = vi.fn();
    const resourceListener = vi.fn();

    bus.on("resource:invalidated", eventListener);
    controller.subscribe("visualization/state", resourceListener);

    controller.invalidate("visualization/state", 11);
    controller.invalidate("visualization/state", 10);

    expect(controller.getRevision("visualization/state")).toBe(11);
    expect(resourceListener).toHaveBeenCalledTimes(1);
    expect(eventListener).toHaveBeenCalledTimes(1);
  });

  it("invalidates subscribed child resources by prefix", () => {
    const bus = new EventBus<KernelEventMap>();
    const controller = new ResourceInvalidationController(bus);
    const fieldListener = vi.fn();
    const scalarListener = vi.fn();

    controller.subscribe("data:fields:m:full", fieldListener);
    controller.subscribe("data:scalars", scalarListener);

    controller.invalidatePrefix("data:fields", 7);

    expect(fieldListener).toHaveBeenCalledWith(7);
    expect(scalarListener).not.toHaveBeenCalled();
    expect(controller.getRevision("data:fields:m:full")).toBe(7);
  });

  it("applies prefix revisions to child resources subscribed after invalidation", () => {
    const bus = new EventBus<KernelEventMap>();
    const controller = new ResourceInvalidationController(bus);

    controller.invalidatePrefix("data:fields", 7);

    expect(controller.getRevision("data:fields:m:full")).toBe(7);
  });

  it("does not move numeric child revisions backwards through prefix revisions", () => {
    const bus = new EventBus<KernelEventMap>();
    const controller = new ResourceInvalidationController(bus);

    controller.invalidate("data:fields:m:full", 9);
    controller.invalidatePrefix("data:fields", 8);

    expect(controller.getRevision("data:fields:m:full")).toBe(9);
  });

  it("lets an exact resource revision supersede an older session-scope prefix", () => {
    const bus = new EventBus<KernelEventMap>();
    const controller = new ResourceInvalidationController(bus);

    controller.subscribe(MODEL_SCENE_PATH, () => {});
    controller.invalidatePrefix(SESSION_CURRENT_PATH, "session:active:10");
    controller.invalidate(MODEL_SCENE_PATH, 16);

    expect(controller.getRevision(MODEL_SCENE_PATH)).toBe(16);
  });
});
