import { describe, expect, it } from "vitest";

import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { ResourceInvalidationController } from "../resources/ResourceInvalidationController";

import { RealtimeInvalidationBridge } from "./RealtimeInvalidationBridge";

describe("RealtimeInvalidationBridge", () => {
  it("maps realtime resource events to resource invalidation", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);

    const handled = bridge.handleEvent({
      resource_key: "session:status",
      revision: 5,
      type: "resource.updated",
    });

    expect(handled).toBe(true);
    expect(resources.getRevision("session:status")).toBe(5);
  });
});
