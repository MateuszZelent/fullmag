import { describe, expect, it } from "vitest";

import {
  sessionResourceIdentitiesEqual,
  sessionResourceIdentityFromStatus,
  sessionResourceIdentityKey,
  sessionScopedResourceKey,
} from "./sessionResourceIdentity";

describe("session resource identity", () => {
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
