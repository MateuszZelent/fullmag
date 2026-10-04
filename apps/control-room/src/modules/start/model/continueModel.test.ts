import { describe, expect, it } from "vitest";

import type { CheckpointEntry } from "@/kernel/api/apiTypes";

import {
  continueLabels,
  formatSimTime,
  homeSubline,
  latestCheckpoint,
  REASON_FAMILY_MISMATCH,
  REASON_GPU_NOT_RESOLVED,
  REASON_LOADING,
  REASON_NO_CHECKPOINT,
  REASON_NO_GPU,
  REASON_NOT_EXACT,
  REASON_PROBING,
  REASON_PROJECT_CLOSED,
  REASON_RESTORING,
  resolveContinue,
  resumeLabel,
  toCatalogState,
  type ContinueLiveInput,
} from "./continueModel";
import type { ComputeEnvironment, ContinueSession, RecentIndexState } from "./types";

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

const checkpoint = (patch: Partial<CheckpointEntry> = {}): CheckpointEntry => ({
  artifact_ref: "a",
  backend_family: "fdm_cuda",
  checkpoint_id: "c-2",
  coordinate_frame: "solver_domain",
  created_at: "2026-10-03T12:04:02Z",
  dt: 1e-13,
  format: "fmstate",
  resume_class: "exact_resume",
  run_id: "r",
  source: "manual",
  step: 256,
  time_s: 3.2e-9,
  vector_count: 1000,
  ...patch,
});

const gpuEnv: ComputeEnvironment = {
  gpus: [{ name: "RTX", vramTotalBytes: 8, vramFreeBytes: 4 }],
  cpuThreads: 8,
  preferredBackend: "cuda",
  warnings: [],
};
const cpuEnv: ComputeEnvironment = { ...gpuEnv, gpus: [], preferredBackend: "cpu" };

const live = (patch: Partial<ContinueLiveInput> = {}): ContinueLiveInput => ({
  catalog: { kind: "ready", checkpoints: [checkpoint()] },
  run: {
    runId: "r",
    requestedDevice: "gpu",
    resolvedDevice: "gpu",
    resolvedRuntimeFamily: "fdm_cuda",
    totalSteps: 400,
  },
  compute: gpuEnv,
  restoring: false,
  ...patch,
});

describe("resolveContinue", () => {
  it("offers the latest exact checkpoint of the open run and applies its progress", () => {
    const result = resolveContinue(
      session,
      live({
        catalog: {
          kind: "ready",
          checkpoints: [
            checkpoint({ checkpoint_id: "c-1", created_at: "2026-10-03T11:00:00Z", step: 100 }),
            checkpoint(),
            checkpoint({ checkpoint_id: "other", run_id: "x", created_at: "2026-10-04T00:00:00Z" }),
          ],
        },
      }),
    );
    expect(result.status).toBe("resumable");
    expect(result.resume).toEqual({ kind: "enabled", checkpointId: "c-2" });
    expect(result.reason).toBeNull();
    expect(result.session.resumable).toBe(true);
    expect(result.session.progress.fraction).toBeCloseTo(256 / 400);
    expect(result.session.progress.simTimeS).toBe(3.2e-9);
    // The index estimate describes an older checkpoint.
    expect(result.session.progress.etaSeconds).toBeNull();
  });

  it("keeps the index fraction when the run has no step total", () => {
    const result = resolveContinue(
      session,
      live({
        run: { runId: "r", requestedDevice: "cpu", resolvedRuntimeFamily: "fdm_cuda", totalSteps: 0 },
      }),
    );
    expect(result.session.progress.fraction).toBe(0.64);
  });

  it("disables Resume with the reason when the project is not open", () => {
    const inputs = [
      null,
      live({ run: null }),
      live({ run: { runId: "other", requestedDevice: "cpu" } }),
    ];
    for (const input of inputs) {
      const result = resolveContinue(session, input);
      expect(result.status).toBe("project-closed");
      expect(result.resume).toEqual({ kind: "disabled", reason: REASON_PROJECT_CLOSED });
      expect(result.reason).toBe(REASON_PROJECT_CLOSED);
      // The index progress is shown exactly as stored.
      expect(result.session.progress).toEqual(session.progress);
    }
  });

  it("removes Resume when the index itself says this machine cannot resume", () => {
    const result = resolveContinue(
      { ...session, resumable: false, notResumableReason: "No CUDA device on this machine." },
      live(),
    );
    expect(result.status).toBe("index-not-resumable");
    expect(result.resume).toEqual({ kind: "hidden" });
    expect(result.reason).toBe("No CUDA device on this machine.");
    expect(resolveContinue({ ...session, resumable: false }, null).reason).toBe(
      "This checkpoint cannot be resumed by this build.",
    );
  });

  it("disables Resume while the restore is in flight", () => {
    const result = resolveContinue(session, live({ restoring: true }));
    expect(result.status).toBe("restoring");
    expect(result.resume).toEqual({ kind: "disabled", reason: REASON_RESTORING });
    expect(resumeLabel(result.status)).toBe("Restoring…");
    expect(resumeLabel("resumable")).toBe("Restore checkpoint");
  });

  it("waits for the catalog instead of guessing", () => {
    for (const catalog of [{ kind: "idle" }, { kind: "loading" }] as const) {
      const result = resolveContinue(session, live({ catalog }));
      expect(result.status).toBe("loading");
      expect(result.resume).toEqual({ kind: "disabled", reason: REASON_LOADING });
    }
  });

  it("reports an API error with its message and does not offer the action", () => {
    const result = resolveContinue(
      session,
      live({ catalog: { kind: "error", message: "502 bad gateway" } }),
    );
    expect(result.status).toBe("error");
    expect(result.reason).toBe("Could not read the checkpoints: 502 bad gateway");
    expect(result.resume.kind).toBe("disabled");
  });

  it("removes Resume when the runtime holds no checkpoint for the run", () => {
    for (const checkpoints of [[], [checkpoint({ run_id: "elsewhere" })]]) {
      const result = resolveContinue(session, live({ catalog: { kind: "ready", checkpoints } }));
      expect(result.status).toBe("no-checkpoint");
      expect(result.resume).toEqual({ kind: "hidden" });
      expect(result.reason).toBe(REASON_NO_CHECKPOINT);
      expect(result.session.resumable).toBe(false);
    }
  });

  it("removes Resume for a checkpoint another build or problem produced", () => {
    const classes = ["logical_resume", "initial_condition_import", "config_only"] as const;
    for (const resume_class of classes) {
      const result = resolveContinue(
        session,
        live({ catalog: { kind: "ready", checkpoints: [checkpoint({ resume_class })] } }),
      );
      expect(result.status).toBe("version-mismatch");
      expect(result.resume).toEqual({ kind: "hidden" });
      expect(result.reason).toBe(REASON_NOT_EXACT[resume_class]);
    }
  });

  it("removes Resume when the checkpoint came from another runtime realization", () => {
    const result = resolveContinue(
      session,
      live({
        catalog: {
          kind: "ready",
          checkpoints: [checkpoint({ backend_family: "fdm_cpu_reference" })],
        },
      }),
    );
    expect(result.status).toBe("version-mismatch");
    expect(result.reason).toBe(REASON_FAMILY_MISMATCH);
  });

  it("never falls back from a forced GPU to the CPU", () => {
    const noGpu = resolveContinue(session, live({ compute: cpuEnv }));
    expect(noGpu.status).toBe("device-unavailable");
    expect(noGpu.resume).toEqual({ kind: "hidden" });
    expect(noGpu.reason).toBe(REASON_NO_GPU);

    const notResolved = resolveContinue(
      session,
      live({
        run: {
          runId: "r",
          requestedDevice: "gpu",
          resolvedDevice: "cpu",
          resolvedRuntimeFamily: "fdm_cpu_reference",
        },
        catalog: {
          kind: "ready",
          checkpoints: [checkpoint({ backend_family: "fdm_cpu_reference" })],
        },
      }),
    );
    expect(notResolved.status).toBe("device-unavailable");
    expect(notResolved.reason).toBe(REASON_GPU_NOT_RESOLVED);
  });

  it("waits for the compute probe before judging a GPU run, and trusts the open session without one", () => {
    const probing = resolveContinue(session, live({ compute: undefined }));
    expect(probing.resume).toEqual({ kind: "disabled", reason: REASON_PROBING });
    // A host that cannot probe (browser build): the open session already holds its device.
    expect(resolveContinue(session, live({ compute: null })).status).toBe("resumable");
  });

  it("does not require a GPU for a CPU run", () => {
    const result = resolveContinue(
      session,
      live({
        run: {
          runId: "r",
          requestedDevice: "cpu",
          resolvedDevice: "cpu",
          resolvedRuntimeFamily: "fdm_cpu_reference",
        },
        compute: cpuEnv,
        catalog: {
          kind: "ready",
          checkpoints: [checkpoint({ backend_family: "fdm_cpu_reference" })],
        },
      }),
    );
    expect(result.status).toBe("resumable");
  });

  it("does not copy resumable from the index when the live session decides", () => {
    // The stored flag says resumable, the live catalog says otherwise.
    const result = resolveContinue(
      { ...session, resumable: true },
      live({ catalog: { kind: "ready", checkpoints: [] } }),
    );
    expect(result.session.resumable).toBe(false);
  });
});

describe("latestCheckpoint", () => {
  it("prefers the newest write and breaks ties on the step", () => {
    const a = checkpoint({ checkpoint_id: "a", step: 1 });
    const b = checkpoint({ checkpoint_id: "b", step: 9 });
    expect(latestCheckpoint([a, b], "r")?.checkpoint_id).toBe("b");
    expect(latestCheckpoint([a, b], "none")).toBeNull();
  });
});

describe("toCatalogState", () => {
  const list = { checkpoints: [checkpoint()] };

  it("maps every resource status", () => {
    expect(toCatalogState({ data: null, status: "idle", error: null })).toEqual({ kind: "idle" });
    expect(toCatalogState({ data: null, status: "loading", error: null })).toEqual({
      kind: "loading",
    });
    expect(toCatalogState({ data: null, status: "error", error: new Error("boom") })).toEqual({
      kind: "error",
      message: "boom",
    });
    expect(toCatalogState({ data: null, status: "ready", error: null })).toEqual({
      kind: "ready",
      checkpoints: [],
    });
    expect(toCatalogState({ data: list, status: "stale", error: null }).kind).toBe("ready");
  });

  it("keeps the last confirmed catalog when a refresh fails", () => {
    expect(toCatalogState({ data: list, status: "error", error: new Error("x") }).kind).toBe(
      "ready",
    );
  });
});
