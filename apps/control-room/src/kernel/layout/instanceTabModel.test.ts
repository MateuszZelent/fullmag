import { describe, expect, it } from "vitest";

import { instanceTabLabel, sessionTone } from "./instanceTabModel";

describe("InstanceTabStrip helpers", () => {
  it("labels a tab with the instance's current session", () => {
    expect(
      instanceTabLabel({
        port: 3206,
        api_instance_id: "a",
        is_self: false,
        sessions: [
          { session_id: "s0", name: "old", status: "closed", current: false },
          { session_id: "s1", name: "live", status: "running", current: true },
        ],
      }),
    ).toBe("live");
    expect(instanceTabLabel({ port: 3210, api_instance_id: "b", is_self: false, sessions: [] })).toBe(
      "No session",
    );
    expect(instanceTabLabel(undefined)).toBe("Unavailable");
  });

  it("colours only running and failed sessions", () => {
    expect(sessionTone("running")).toBe("running");
    expect(sessionTone("waiting_for_compute")).toBe("waiting");
    expect(sessionTone("activating")).toBe("starting");
    expect(sessionTone("materializing_script")).toBe("starting");
    expect(sessionTone("failed")).toBe("failed");
    expect(sessionTone("awaiting_command")).toBe("idle");
    expect(sessionTone(undefined)).toBe("idle");
  });
});
