import { describe, expect, it } from "vitest";

import type { LiveStatusResource } from "../api/apiTypes";

import {
  INITIAL_RUN_OUTCOME_TRACKER,
  advanceRunOutcomeTracker,
  classifySolverState,
  observeRunLifecycle,
  runLifecycleObservationsEqual,
  runOutcomeFromStatusTransition,
  type RunLifecycleObservation,
} from "./runOutcome";

const T0 = Date.parse("2026-10-04T10:00:00.000Z");

function observation(
  solverState: string,
  overrides: Partial<RunLifecycleObservation> = {},
): RunLifecycleObservation {
  return {
    discretization: "fdm",
    run: { resolvedDevice: "gpu", runId: "run-1", startedAt: String(T0 - 60_000) },
    sessionKey: "session-1\u0000epoch-1",
    solverState,
    ...overrides,
  };
}

function status(
  lifecycleSolver: string,
  overrides: Record<string, unknown> = {},
): LiveStatusResource {
  return {
    domain: { cell_count: 8, discretization: "fem", generation_id: "g" },
    lifecycle: { solver: lifecycleSolver },
    run: {
      requested_device: "auto",
      resolved_device: "cuda:0",
      run_id: "run-9",
      started_at: "1791108000000",
    },
    session: { session_epoch: "epoch-1", session_id: "session-1" },
    solver: { state: "idle" },
    ...overrides,
  } as unknown as LiveStatusResource;
}

describe("classifySolverState", () => {
  it("separates active, terminal and other states", () => {
    expect(["running", "paused", "breaking"].map(classifySolverState)).toEqual([
      "active",
      "active",
      "active",
    ]);
    expect(classifySolverState("completed")).toBe("ready");
    expect(classifySolverState("finished")).toBe("ready");
    expect(classifySolverState("failed")).toBe("failed");
    expect(classifySolverState("error")).toBe("failed");
    expect(classifySolverState("Cancelled")).toBe("cancelled");
    for (const state of ["idle", "awaiting_command", "bootstrapping", "", "closing"]) {
      expect(classifySolverState(state)).toBe("other");
    }
  });
});

describe("observeRunLifecycle", () => {
  it("prefers the lifecycle runtime status and carries run and backend", () => {
    expect(observeRunLifecycle(status("completed"))).toEqual({
      discretization: "fem",
      run: { resolvedDevice: "cuda:0", runId: "run-9", startedAt: "1791108000000" },
      sessionKey: "session-1\u0000epoch-1",
      solverState: "completed",
    });
  });

  it("falls back to the thin solver state and tolerates a missing run", () => {
    const observed = observeRunLifecycle(
      status("", { run: null, solver: { state: "finished" } }),
    );
    expect(observed?.solverState).toBe("finished");
    expect(observed?.run).toBeNull();
  });

  it("has no observation without a session identity", () => {
    expect(observeRunLifecycle(null)).toBeNull();
    expect(
      observeRunLifecycle(status("running", { session: { session_epoch: "", session_id: "s" } })),
    ).toBeNull();
  });

  it("compares observations structurally", () => {
    expect(
      runLifecycleObservationsEqual(observation("running"), observation("running")),
    ).toBe(true);
    expect(
      runLifecycleObservationsEqual(observation("running"), observation("completed")),
    ).toBe(false);
    expect(runLifecycleObservationsEqual(null, observation("running"))).toBe(false);
  });
});

describe("runOutcomeFromStatusTransition", () => {
  it("reports a ready outcome when a running run completes", () => {
    const outcome = runOutcomeFromStatusTransition(
      observation("running"),
      observation("completed"),
      { activeSinceMs: T0, nowMs: T0 + 90_500 },
    );
    expect(outcome).toEqual({
      backend: "FDM",
      device: "gpu",
      duration_seconds: 90.5,
      finished_at: "2026-10-04T10:01:30.500Z",
      run_id: "run-1",
      started_at: "2026-10-04T10:00:00.000Z",
      status: "ready",
    });
  });

  it("maps failed and cancelled terminal states and paused starts", () => {
    expect(
      runOutcomeFromStatusTransition(observation("paused"), observation("failed"), { nowMs: T0 })
        ?.status,
    ).toBe("failed");
    expect(
      runOutcomeFromStatusTransition(observation("running"), observation("cancelled"), {
        nowMs: T0,
      })?.status,
    ).toBe("cancelled");
  });

  it("falls back to the status start time and never reports a negative duration", () => {
    const outcome = runOutcomeFromStatusTransition(
      observation("running", { run: { resolvedDevice: "cpu", runId: "r", startedAt: String(T0 + 5000) } }),
      observation("completed", { run: null }),
      { nowMs: T0 },
    );
    expect(outcome?.run_id).toBe("r");
    expect(outcome?.started_at).toBe("2026-10-04T10:00:05.000Z");
    expect(outcome?.duration_seconds).toBe(0);
    expect(outcome?.device).toBe("cpu");
  });

  it("is silent unless an active run reaches a terminal state in the same session", () => {
    const now = { nowMs: T0 };
    expect(runOutcomeFromStatusTransition(null, observation("completed"), now)).toBeNull();
    expect(runOutcomeFromStatusTransition(observation("running"), null, now)).toBeNull();
    expect(
      runOutcomeFromStatusTransition(observation("running"), observation("running"), now),
    ).toBeNull();
    expect(
      runOutcomeFromStatusTransition(observation("completed"), observation("completed"), now),
    ).toBeNull();
    expect(
      runOutcomeFromStatusTransition(observation("running"), observation("awaiting_command"), now),
    ).toBeNull();
    expect(
      runOutcomeFromStatusTransition(observation("idle"), observation("completed"), now),
    ).toBeNull();
    expect(
      runOutcomeFromStatusTransition(
        observation("running"),
        observation("completed", { sessionKey: "session-2\u0000epoch-1" }),
        now,
      ),
    ).toBeNull();
    expect(
      runOutcomeFromStatusTransition(
        observation("running"),
        observation("completed", {
          run: { resolvedDevice: "gpu", runId: "run-2", startedAt: "1" },
        }),
        now,
      ),
    ).toBeNull();
    expect(
      runOutcomeFromStatusTransition(
        observation("running", { run: null }),
        observation("completed"),
        now,
      ),
    ).toBeNull();
  });
});

describe("advanceRunOutcomeTracker", () => {
  it("records exactly once per run and attributes a missed intermediate poll", () => {
    let tracker = INITIAL_RUN_OUTCOME_TRACKER;
    const outcomes = [];
    const steps: Array<[RunLifecycleObservation | null, number]> = [
      [observation("completed"), T0],
      [observation("running"), T0 + 1000],
      [observation("running"), T0 + 2000],
      [observation("completed"), T0 + 62_000],
      [observation("completed"), T0 + 63_000],
    ];
    for (const [next, nowMs] of steps) {
      const result = advanceRunOutcomeTracker(tracker, next, nowMs);
      tracker = result.tracker;
      if (result.outcome) outcomes.push(result.outcome);
    }
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      duration_seconds: 61,
      run_id: "run-1",
      started_at: new Date(T0 + 1000).toISOString(),
      status: "ready",
    });
  });

  it("drops an active run when the session changes or the status disappears", () => {
    const active = advanceRunOutcomeTracker(INITIAL_RUN_OUTCOME_TRACKER, observation("running"), T0);
    const otherSession = advanceRunOutcomeTracker(
      active.tracker,
      observation("completed", { sessionKey: "session-2\u0000epoch-1" }),
      T0 + 1000,
    );
    expect(otherSession.outcome).toBeNull();
    expect(otherSession.tracker.active).toBeNull();
    expect(advanceRunOutcomeTracker(active.tracker, null, T0 + 1000).tracker.active).toBeNull();
  });

  it("forgets the active run when it stops without a terminal state", () => {
    const active = advanceRunOutcomeTracker(INITIAL_RUN_OUTCOME_TRACKER, observation("running"), T0);
    const idle = advanceRunOutcomeTracker(active.tracker, observation("awaiting_command"), T0 + 1);
    expect(idle.outcome).toBeNull();
    expect(advanceRunOutcomeTracker(idle.tracker, observation("completed"), T0 + 2).outcome).toBeNull();
  });
});
