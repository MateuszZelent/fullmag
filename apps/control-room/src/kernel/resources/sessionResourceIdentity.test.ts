import { describe, expect, it } from "vitest";

import {
  sessionResourceIdentitiesEqual,
  sessionResourceIdentityFromStatus,
  sessionScopedResourceKey,
} from "./sessionResourceIdentity";

describe("session resource identity", () => {
  it("makes identical resource paths distinct across session epochs", () => {
    const first = { sessionId: "session-1", sessionEpoch: "epoch-1" };
    const second = { sessionId: "session-1", sessionEpoch: "epoch-2" };

    const resourceKey = ["", "v2", "sessions", "current", "data", "fields", "m", "vector"].join("/");
    expect(sessionScopedResourceKey(first, resourceKey))
      .not.toBe(sessionScopedResourceKey(second, resourceKey));
    expect(sessionResourceIdentitiesEqual(first, second)).toBe(false);
  });

  it("rejects a status without the complete authoritative identity", () => {
    expect(sessionResourceIdentityFromStatus(null)).toBeNull();
    expect(sessionResourceIdentityFromStatus({ session: {} } as never)).toBeNull();
    expect(sessionResourceIdentityFromStatus({
      session: { session_id: "session-1", session_epoch: " " },
    } as never)).toBeNull();
  });
});
