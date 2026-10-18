import { describe, expect, it } from "vitest";

import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import {
  ANALYSIS_DYNAMIC_STRUCTURE_FACTOR_V1_PATH,
  ANALYSIS_SPIN_WAVE_GAMMA_V1_PATH,
  DATA_ARTIFACTS_PATH,
} from "../api/apiPaths";
import { ResourceInvalidationController } from "../resources/ResourceInvalidationController";
import { RealtimeInvalidationBridge } from "./RealtimeInvalidationBridge";

describe("spin-wave artifact invalidation", () => {
  it("refreshes scoped Gamma and DSF without regressing revisions or reacting to logs", () => {
    const resources = new ResourceInvalidationController(new EventBus<KernelEventMap>());
    const bridge = new RealtimeInvalidationBridge(resources, {
      scheduleFlush: (callback) => { callback(); return () => {}; },
    });
    const paths = [ANALYSIS_SPIN_WAVE_GAMMA_V1_PATH, ANALYSIS_DYNAMIC_STRUCTURE_FACTOR_V1_PATH];
    const keys = paths.map((path) => `session=s&epoch=e|${path}`);
    const unsubscribe = keys.map((key) => resources.subscribe(key, () => {}));
    let sequence = 1;
    const publish = (resource: string, revision: number, runId = "r") => bridge.handleEvent({
      type: "resource.batch_changed", session_id: "s", run_id: runId, seq: ++sequence,
      payload: { changes: [{ resource, revision, ...(resource === "artifacts" ? { recommended_fetch: DATA_ARTIFACTS_PATH } : {}) }] },
    });
    bridge.handleEvent({ type: "hello", session_id: "s", run_id: "r", seq: 1, payload: { resource_revisions: {} } });
    publish("artifacts", 17);
    for (const key of keys) expect(resources.getRevision(key)).toBe(17);
    const lateKey = `session=s&epoch=late|${ANALYSIS_DYNAMIC_STRUCTURE_FACTOR_V1_PATH}`;
    unsubscribe.push(resources.subscribe(lateKey, () => {}));
    expect(resources.getRevision(lateKey)).toBe(17);
    publish("logs", 18);
    publish("artifacts", 16);
    for (const key of keys) expect(resources.getRevision(key)).toBe(17);
    publish("artifacts", 19, "r2");
    for (const key of keys) expect(resources.getRevision(key)).toBe(19);
    for (const release of unsubscribe) release();
  });
});
