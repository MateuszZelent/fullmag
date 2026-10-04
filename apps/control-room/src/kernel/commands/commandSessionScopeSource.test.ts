import { describe, expect, it, vi } from "vitest";

import type { LiveStatusResource, SessionListResource } from "../api/apiTypes";
import { SESSIONS_PATH } from "../api/apiPaths";
import {
  ResourceRuntimeStore,
} from "../resources/ResourceRuntimeStore";
import { SESSION_STATUS_RESOURCE_KEY } from "../resources/useSessionStatus";
import { createCommandSessionScopeSource } from "./commandSessionScopeSource";

function status(sessionId: string, sessionEpoch: string, requestScopeEpoch = `test-api:${sessionId}`): LiveStatusResource {
  return {
    session: {
      session_id: sessionId,
      session_epoch: sessionEpoch,
      request_scope_epoch: requestScopeEpoch,
    },
  } as LiveStatusResource;
}

describe("createCommandSessionScopeSource", () => {
  it("reads scope from the shared resource and unsubscribes cleanly", () => {
    const runtimeStore = new ResourceRuntimeStore();
    runtimeStore.updateData(SESSIONS_PATH, { sessions: [{ current: true, session_id: "session-a" }] } as SessionListResource, "test-revision");
    const source = createCommandSessionScopeSource(runtimeStore);
    const listener = vi.fn();

    expect(source.getScopeKey()).toBeNull();
    const unsubscribe = source.subscribe(listener);

    runtimeStore.updateData(
      SESSION_STATUS_RESOURCE_KEY,
      status("session-a", "epoch-1"),
      1,
    );
    expect(listener).toHaveBeenCalledTimes(1);
    expect(source.getScopeKey()).toBe("session=session-a&epoch=epoch-1&request_scope_epoch=test-api%3Asession-a");

    runtimeStore.updateData(
      SESSION_STATUS_RESOURCE_KEY,
      status("session-b", "epoch-2"),
      2,
    );
    expect(listener).toHaveBeenCalledTimes(2);
    expect(source.getScopeKey()).toBeNull();
    runtimeStore.updateData(SESSIONS_PATH, { sessions: [{ current: true, session_id: "session-b" }] } as SessionListResource, "test-revision");
    expect(listener).toHaveBeenCalledTimes(3);
    expect(source.getScopeKey()).toBe("session=session-b&epoch=epoch-2&request_scope_epoch=test-api%3Asession-b");

    unsubscribe();
    runtimeStore.updateData(
      SESSION_STATUS_RESOURCE_KEY,
      status("session-c", "epoch-3"),
      3,
    );
    expect(listener).toHaveBeenCalledTimes(3);
    expect(source.getScopeKey()).toBeNull();
    runtimeStore.updateData(SESSIONS_PATH, { sessions: [{ current: true, session_id: "session-c" }] } as SessionListResource, "test-revision");
    expect(listener).toHaveBeenCalledTimes(3);
    expect(source.getScopeKey()).toBe("session=session-c&epoch=epoch-3&request_scope_epoch=test-api%3Asession-c");
  });

  it("changes command scope when the same scientific session is reopened", () => {
    const runtimeStore = new ResourceRuntimeStore();
    runtimeStore.updateData(SESSIONS_PATH, { sessions: [{ current: true, session_id: "session-a" }] } as SessionListResource, "test-revision");
    const source = createCommandSessionScopeSource(runtimeStore);
    runtimeStore.updateData(SESSION_STATUS_RESOURCE_KEY, status("session-a", "epoch-1", "api:1"), 1);
    const first = source.getScopeKey();
    runtimeStore.updateData(SESSION_STATUS_RESOURCE_KEY, status("session-a", "epoch-1", "api:2"), 2);
    expect(source.getScopeKey()).not.toBe(first);
  });

  it("revokes pending command scope when the collection confirms no session despite cached status", () => {
    const runtimeStore = new ResourceRuntimeStore();
    const source = createCommandSessionScopeSource(runtimeStore);
    runtimeStore.updateData(SESSION_STATUS_RESOURCE_KEY, status("session-a", "epoch-1"), 1);
    expect(source.getScopeKey()).toBeNull();
    runtimeStore.updateData(SESSIONS_PATH, { sessions: [{ current: true, session_id: "session-a" }] } as SessionListResource, "test-revision");
    expect(source.getScopeKey()).not.toBeNull();
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);
    runtimeStore.updateData(SESSIONS_PATH, { schema_version: "2.0.0", sessions: [] } as SessionListResource, "test-revision");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(source.getScopeKey()).toBeNull();
    unsubscribe();
  });
});
