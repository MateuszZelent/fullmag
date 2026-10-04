import { describe, expect, it } from "vitest";

import { continueLabels, formatSimTime, homeSubline } from "./continueModel";
import type { ContinueSession, RecentIndexState } from "./types";

const session: ContinueSession = {
  projectId: "p",
  runId: "r",
  checkpointAt: "",
  resumable: true,
  progress: {
    fraction: 0.64,
    simTimeS: 3.2e-9,
    simTimeTotalS: 5e-9,
    framesWritten: 256,
    framesTotal: 400,
    etaSeconds: 720,
  },
};

describe("formatSimTime", () => {
  it("picks the unit that reads naturally", () => {
    expect(formatSimTime(5e-13)).toBe("0.5 ps");
    expect(formatSimTime(3.2e-9)).toBe("3.20 ns");
    expect(formatSimTime(2.5e-6)).toBe("2.50 µs");
  });
});

describe("continueLabels", () => {
  it("combines time, estimate and frames", () => {
    const labels = continueLabels(session);
    expect(labels.percent).toBe(64);
    expect(labels.timeLabel).toBe("paused at t = 3.20 ns / 5.00 ns");
    expect(labels.detail).toBe("≈ 12 min · 256 / 400 frames");
    expect(labels.valueText).toBe("64 percent, ≈ 12 min remaining");
  });

  it("renders nothing rather than a guess when there is no estimate", () => {
    const labels = continueLabels({
      ...session,
      progress: { fraction: 0.5, etaSeconds: null },
    });
    expect(labels.detail).toBeNull();
    expect(labels.timeLabel).toBe("paused");
    expect(labels.valueText).toBe("50 percent");
  });
});

describe("homeSubline", () => {
  const entry = {
    projectId: "p",
    name: "P",
    path: "/p.fms",
    solver: "FDM" as const,
    status: "ready" as const,
    lastOpenedAt: "2026-10-03T00:00:00Z",
  };
  const ready = (withRun: boolean): RecentIndexState => ({
    kind: "ready",
    index: {
      formatVersion: 1,
      generatedAt: "",
      entries: [entry],
      continue: withRun ? session : undefined,
    },
  });

  it("mentions the paused run first and counts projects", () => {
    expect(homeSubline(ready(true))).toBe(
      "One run is paused and waiting. 1 project is indexed on this machine.",
    );
  });

  it("states only the count when there is nothing to resume", () => {
    expect(homeSubline(ready(false))).toBe("1 project is indexed on this machine.");
  });

  it("falls back to the generic invitation without an index", () => {
    expect(homeSubline({ kind: "unavailable" })).toContain("empty FDM or FEM problem");
  });
});
