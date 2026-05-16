import { describe, expect, it } from "vitest";

import { buildStudyRuntimeCommand } from "./studyRuntimeCommandAdapters";

describe("study runtime command adapters", () => {
  it("builds study-level compute commands with explicit intent metadata", () => {
    const command = buildStudyRuntimeCommand("compute_energies", {
      clientIntentId: "intent-energies",
      precondition: {
        command_revision: 4,
        runtime_state: "running",
        stage_execution_revision: 7,
      },
      requestedAtUnixMs: 1_778_754_400_000,
    });

    expect(command).toEqual({
      client_intent_id: "intent-energies",
      kind: "compute_energies",
      precondition: {
        command_revision: 4,
        runtime_state: "running",
        stage_execution_revision: 7,
      },
      reason: "user_requested",
      requested_at_unix_ms: 1_778_754_400_000,
      target: { kind: "study" },
    });
  });

  it("targets stage controls at the current stage by default", () => {
    const command = buildStudyRuntimeCommand("pause", {
      clientIntentId: "intent-pause",
      requestedAtUnixMs: 1_778_754_401_000,
    });

    expect(command).toEqual({
      client_intent_id: "intent-pause",
      kind: "pause",
      reason: "user_requested",
      requested_at_unix_ms: 1_778_754_401_000,
      target: { kind: "current_stage" },
    });
  });
});
