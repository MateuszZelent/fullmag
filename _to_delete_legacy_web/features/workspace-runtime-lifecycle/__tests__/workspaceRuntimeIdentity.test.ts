import { describe, expect, it } from "vitest";

import { resolveWorkspaceRuntimeIdentity } from "../workspaceRuntimeIdentity";

describe("resolveWorkspaceRuntimeIdentity", () => {
  it("splits document, runtime and run identity", () => {
    expect(
      resolveWorkspaceRuntimeIdentity({
        sessionId: "session-a",
        runId: "run-1",
        scriptPath: "/tmp/model.py",
        sourceHash: "sha256:a",
      }),
    ).toEqual({
      documentIdentity: "/tmp/model.py:sha256:a",
      runtimeIdentity: "session-a",
      runIdentity: "session-a:run-1",
    });
  });

  it("keeps document identity stable when only run id changes", () => {
    const first = resolveWorkspaceRuntimeIdentity({
      sessionId: "session-a",
      runId: "run-1",
      scriptPath: "/tmp/model.py",
      sourceHash: "sha256:a",
    });
    const second = resolveWorkspaceRuntimeIdentity({
      sessionId: "session-a",
      runId: "run-2",
      scriptPath: "/tmp/model.py",
      sourceHash: "sha256:a",
    });

    expect(second.documentIdentity).toBe(first.documentIdentity);
    expect(second.runIdentity).not.toBe(first.runIdentity);
  });

  it("keeps document identity stable when only session id changes", () => {
    const first = resolveWorkspaceRuntimeIdentity({
      sessionId: "session-a",
      runId: "run-1",
      scriptPath: "/tmp/model.py",
      sourceHash: "sha256:a",
    });
    const second = resolveWorkspaceRuntimeIdentity({
      sessionId: "session-b",
      runId: "run-1",
      scriptPath: "/tmp/model.py",
      sourceHash: "sha256:a",
    });

    expect(second.documentIdentity).toBe(first.documentIdentity);
    expect(second.runtimeIdentity).not.toBe(first.runtimeIdentity);
    expect(second.runIdentity).not.toBe(first.runIdentity);
  });

  it("returns null identities before a runtime session exists", () => {
    expect(
      resolveWorkspaceRuntimeIdentity({
        sessionId: null,
        runId: "run-1",
        scriptPath: "/tmp/model.py",
        sourceHash: "sha256:a",
      }),
    ).toEqual({
      documentIdentity: null,
      runtimeIdentity: null,
      runIdentity: null,
    });
  });
});
