import { describe, expect, it } from "vitest";

import { selectSessionLifecycle } from "./sessionLifecycle";

describe("selectSessionLifecycle", () => {
  it("uses explicit commandability instead of inferring it from solver state", () => {
    const lifecycle = selectSessionLifecycle({
      connectivity: "connected",
      session_resource: "active",
      solver: "completed",
      commandability: "allowed",
    });

    expect(lifecycle.canSubmitCommands).toBe(true);
    expect(lifecycle.isTerminal).toBe(false);
  });

  it("keeps a completed tombstone read-only even while connected", () => {
    const lifecycle = selectSessionLifecycle({
      connectivity: "connected",
      session_resource: "tombstoned",
      solver: "completed",
      commandability: "read_only",
    });

    expect(lifecycle.canSubmitCommands).toBe(false);
    expect(lifecycle.isTerminal).toBe(true);
    expect(lifecycle.isConnected).toBe(true);
  });

  it("does not rewrite connectivity loss into solver lifecycle", () => {
    const lifecycle = selectSessionLifecycle({
      connectivity: "disconnected",
      session_resource: "active",
      solver: "running",
      commandability: "forbidden",
    });

    expect(lifecycle.solver).toBe("running");
    expect(lifecycle.isConnected).toBe(false);
    expect(lifecycle.canSubmitCommands).toBe(false);
  });

  it("consumes degraded connectivity independently from commandability", () => {
    const lifecycle = selectSessionLifecycle({
      connectivity: "degraded",
      session_resource: "active",
      solver: "running",
      commandability: "forbidden",
    });

    expect(lifecycle.solver).toBe("running");
    expect(lifecycle.isConnected).toBe(false);
    expect(lifecycle.canSubmitCommands).toBe(false);
  });
});
