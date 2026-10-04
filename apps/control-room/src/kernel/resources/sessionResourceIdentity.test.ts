import { describe, expect, it } from "vitest";

import {
  confirmedSessionResourceIdentity,
  sessionResourceIdentitiesEqual,
  sessionResourceIdentityFromStatus,
  sessionResourceIdentityKey,
  sessionScopedResourceKey,
} from "./sessionResourceIdentity";

describe("session resource identity", () => {
  it("requires exactly one current collection entry matching the status identity", () => {
    const identity = { sessionId: "session-a", sessionEpoch: "epoch-1", requestScopeEpoch: "api:1" };
    const collection = (sessions: { current: boolean; session_id: string }[]) => ({ sessions }) as import("../api/apiTypes").SessionListResource;
    expect(confirmedSessionResourceIdentity(identity, collection([]))).toBeNull();
    expect(confirmedSessionResourceIdentity(identity, collection([{ current: true, session_id: "session-b" }]))).toBeNull();
    expect(confirmedSessionResourceIdentity(identity, collection([{ current: false, session_id: "session-a" }]))).toBeNull();
    expect(confirmedSessionResourceIdentity(identity, collection([{ current: true, session_id: "session-a" }]))).toBe(identity);
  });
  it("makes identical resource paths distinct across session epochs", () => {
    const first = { sessionId: "session-1", sessionEpoch: "epoch-1", requestScopeEpoch: "api:1" };
    const second = { sessionId: "session-1", sessionEpoch: "epoch-2", requestScopeEpoch: "api:2" };

    const resourceKey = ["", "v2", "sessions", "current", "data", "fields", "m", "vector"].join("/");
    expect(sessionScopedResourceKey(first, resourceKey))
      .not.toBe(sessionScopedResourceKey(second, resourceKey));
    expect(sessionResourceIdentitiesEqual(first, second)).toBe(false);
  });

  it("separates reopened sessions with the same scientific identity", () => {
    const first = { sessionId: "session-1", sessionEpoch: "epoch-1", requestScopeEpoch: "api:1" };
    const reopened = { ...first, requestScopeEpoch: "api:2" };
    expect(sessionResourceIdentitiesEqual(first, reopened)).toBe(false);
    expect(sessionScopedResourceKey(first, "model/scene"))
      .not.toBe(sessionScopedResourceKey(reopened, "model/scene"));
  });

  it("rejects a status without the complete authoritative identity", () => {
    expect(sessionResourceIdentityFromStatus(null)).toBeNull();
    expect(sessionResourceIdentityFromStatus({ session: {} } as never)).toBeNull();
    expect(sessionResourceIdentityFromStatus({
      session: { session_id: "session-1", session_epoch: " " },
    } as never)).toBeNull();
    expect(sessionResourceIdentityFromStatus({
      session: { session_id: "session-1", session_epoch: "epoch-1" },
    } as never)).toBeNull();
  });

  it("provides a stable opaque scope key for controller caches", () => {
    expect(
      sessionResourceIdentityKey({
        sessionId: "session-a",
        sessionEpoch: "session-a@7",
        requestScopeEpoch: "api:7",
      }),
    ).toBe("session-a\u0000session-a@7\u0000api:7");
  });
});
