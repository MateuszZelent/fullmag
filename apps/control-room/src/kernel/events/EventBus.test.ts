import { describe, expect, it } from "vitest";

import { EventBus } from "./EventBus";
import type { KernelEventMap } from "./eventTypes";

describe("EventBus", () => {
  it("delivers typed payloads to subscribers and supports unsubscribe", () => {
    const bus = new EventBus<KernelEventMap>();
    const received: string[] = [];

    const unsubscribe = bus.on("workspace:module-activated", (event) => {
      received.push(`${event.moduleId}:${event.slotId}`);
    });

    bus.emit("workspace:module-activated", {
      moduleId: "status-bar",
      slotId: "status-bar",
    });
    unsubscribe();
    bus.emit("workspace:module-activated", {
      moduleId: "ribbon",
      slotId: "ribbon",
    });

    expect(received).toEqual(["status-bar:status-bar"]);
  });
});
