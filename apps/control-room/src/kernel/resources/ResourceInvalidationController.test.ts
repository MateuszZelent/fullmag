import { describe, expect, it, vi } from "vitest";

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
});
