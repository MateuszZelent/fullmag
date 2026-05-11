import { describe, expect, it } from "vitest";

import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { SIMULATION_COMMANDS_PATH } from "../api/apiPaths";
import { ResourceInvalidationController } from "../resources/ResourceInvalidationController";

import { RealtimeInvalidationBridge } from "./RealtimeInvalidationBridge";

describe("RealtimeInvalidationBridge", () => {
  it("maps backend resource batch events to resource invalidation", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);

    const handled = bridge.handleEvent({
      payload: {
        changes: [
          {
            recommended_fetch: SIMULATION_COMMANDS_PATH,
            resource: "commands",
            revision: 5,
          },
        ],
      },
      type: "resource.batch_changed",
    });

    expect(handled).toBe(true);
    expect(resources.getRevision("session:status")).toBe(5);
    expect(resources.getRevision(SIMULATION_COMMANDS_PATH)).toBe(5);
  });

  it("ignores realtime lifecycle events without resource changes", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);

    expect(bridge.handleEvent({ type: "heartbeat" })).toBe(false);
  });

  it("maps resync-required events to status invalidation", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);

    const handled = bridge.handleEvent({
      payload: {
        reason: "sequence_gap",
        replay_available_after_seq: 12,
      },
      type: "resync.required",
    });

    expect(handled).toBe(true);
    expect(resources.getRevision("session:status")).toBe(12);
  });
});
