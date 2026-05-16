import { describe, expect, it } from "vitest";

import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import {
  DATA_FIELDS_PATH,
  DATA_FIELD_VECTOR_PATH,
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  MESHING_OBJECT_QUALITY_PATH,
  MESHING_OBJECT_REPORT_PATH,
  MESHING_OBJECT_SIZE_FIELD_PATH,
  MESHING_OBJECT_TOPOLOGY_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MODEL_SCENE_PATH,
  SIMULATION_COMMANDS_PATH,
  VISUALIZATION_CLIENT_ACKS_PATH,
  VISUALIZATION_STATE_PATH,
} from "../api/apiPaths";
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

  it("coalesces session status invalidation once per backend batch", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);
    let statusInvalidations = 0;

    bus.on("resource:invalidated", ({ resourceKey }) => {
      if (resourceKey === "session:status") {
        statusInvalidations += 1;
      }
    });

    const handled = bridge.handleEvent({
      payload: {
        changes: [
          {
            recommended_fetch: SIMULATION_COMMANDS_PATH,
            resource: "commands",
            revision: 5,
          },
          {
            recommended_fetch: VISUALIZATION_STATE_PATH,
            resource: "visualization_state",
            revision: 6,
          },
        ],
      },
      type: "resource.batch_changed",
    });

    expect(handled).toBe(true);
    expect(statusInvalidations).toBe(1);
    expect(resources.getRevision("session:status")).toBe(6);
    expect(resources.getRevision(SIMULATION_COMMANDS_PATH)).toBe(5);
    expect(resources.getRevision(VISUALIZATION_STATE_PATH)).toBe(6);
  });

  it("does not refresh session status for visualization client ack batches", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);

    const handled = bridge.handleEvent({
      payload: {
        changes: [
          {
            recommended_fetch: VISUALIZATION_CLIENT_ACKS_PATH,
            resource: "visualization_client_acks",
            revision: 9,
          },
        ],
      },
      type: "resource.batch_changed",
    });

    expect(handled).toBe(true);
    expect(resources.getRevision("session:status")).toBeNull();
    expect(resources.getRevision(VISUALIZATION_CLIENT_ACKS_PATH)).toBe(9);
  });

  it("suppresses invalidations that were already satisfied locally", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources, {
      shouldSuppressInvalidation: (resourceKey, revision) =>
        resourceKey === VISUALIZATION_STATE_PATH && revision === 44,
    });

    const handled = bridge.handleEvent({
      payload: {
        changes: [
          {
            recommended_fetch: VISUALIZATION_STATE_PATH,
            resource: "visualization",
            revision: 44,
          },
        ],
      },
      type: "resource.batch_changed",
    });

    expect(handled).toBe(true);
    expect(resources.getRevision("session:status")).toBe(44);
    expect(resources.getRevision(VISUALIZATION_STATE_PATH)).toBeNull();
  });

  it("maps resource family changes to subscribed child resources", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);
    const fieldKey = `${DATA_FIELD_VECTOR_PATH.replace(
      "{quantity_id}",
      "m",
    )}?component=full&scope_kind=part&scope_id=body`;

    resources.subscribe(fieldKey, () => {});

    const handled = bridge.handleEvent({
      payload: {
        changes: [
          {
            recommended_fetch: DATA_FIELDS_PATH,
            resource: "fields",
            revision: 8,
          },
        ],
      },
      type: "resource.batch_changed",
    });

    expect(handled).toBe(true);
    expect(resources.getRevision(fieldKey)).toBe(8);
  });

  it("refreshes mesh build dependents after latest successful build changes", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);
    const objectTopologyKey = MESHING_OBJECT_TOPOLOGY_PATH.replace(
      "{object_id}",
      "box",
    );
    const objectReportKey = MESHING_OBJECT_REPORT_PATH.replace(
      "{object_id}",
      "box",
    );
    const objectQualityKey = MESHING_OBJECT_QUALITY_PATH.replace(
      "{object_id}",
      "box",
    );
    const objectSizeFieldKey = MESHING_OBJECT_SIZE_FIELD_PATH.replace(
      "{object_id}",
      "box",
    );

    for (const resourceKey of [
      objectTopologyKey,
      objectReportKey,
      objectQualityKey,
      objectSizeFieldKey,
    ]) {
      resources.subscribe(resourceKey, () => {});
    }

    const handled = bridge.handleEvent({
      payload: {
        changes: [
          {
            recommended_fetch: MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
            resource: "mesh-builds",
            revision: "mesh-build-9",
          },
        ],
      },
      type: "resource.batch_changed",
    });

    expect(handled).toBe(true);
    expect(resources.getRevision(MESHING_BUILDS_LATEST_SUCCESSFUL_PATH)).toBe(
      "mesh-build-9",
    );
    expect(resources.getRevision(MODEL_SCENE_PATH)).toBe("mesh-build-9");
    expect(resources.getRevision(MESHING_SHARED_DOMAIN_MANIFEST_PATH)).toBe(
      "mesh-build-9",
    );
    expect(resources.getRevision(VISUALIZATION_STATE_PATH)).toBe("mesh-build-9");
    expect(resources.getRevision(objectTopologyKey)).toBe("mesh-build-9");
    expect(resources.getRevision(objectReportKey)).toBe("mesh-build-9");
    expect(resources.getRevision(objectQualityKey)).toBe("mesh-build-9");
    expect(resources.getRevision(objectSizeFieldKey)).toBe("mesh-build-9");
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
