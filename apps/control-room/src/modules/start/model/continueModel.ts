import type { CheckpointEntry, CheckpointListResource } from "@/kernel/api/apiTypes";

import { formatEta } from "./recentIndex";
import type { ComputeProbeState, ContinueSession, RecentIndexState } from "./types";

/** Simulated time is sub-microsecond here; ns is the useful unit. */
export function formatSimTime(seconds: number): string {
  const ns = seconds * 1e9;
  if (ns < 1) return `${(ns * 1e3).toFixed(1)} ps`;
  if (ns < 1000) return `${ns.toFixed(2)} ns`;
  return `${(ns / 1e3).toFixed(2)} µs`;
}

export interface ContinueLabels {
  readonly percent: number;
  readonly timeLabel: string;
  /** ETA and frame count; null when neither is known, so nothing is guessed. */
  readonly detail: string | null;
  readonly valueText: string;
}

export function continueLabels(session: ContinueSession): ContinueLabels {
  const { fraction, simTimeS, simTimeTotalS, framesWritten, framesTotal, etaSeconds } =
    session.progress;
  const percent = Math.round(fraction * 100);
  const eta = formatEta(etaSeconds);
  const frames =
    framesWritten != null && framesTotal != null ? `${framesWritten} / ${framesTotal} frames` : null;
  return {
    percent,
    timeLabel:
      simTimeS != null && simTimeTotalS != null
        ? `paused at t = ${formatSimTime(simTimeS)} / ${formatSimTime(simTimeTotalS)}`
        : "paused",
    detail: [eta, frames].filter(Boolean).join(" · ") || null,
    valueText: eta ? `${percent} percent, ${eta} remaining` : `${percent} percent`,
  };
}

/** The line under the greeting says what is worth knowing, then stops. */
export function homeSubline(state: RecentIndexState, scriptCount: number | null = null): string {
  const fallback = "Start from an empty FDM or FEM problem, or open a project archive.";
  // `scriptCount` is null unless the list shows scripts too (kind All, host available).
  const scripts = scriptCount !== null && scriptCount > 0 ? scriptCount : 0;
  if (state.kind !== "ready") {
    return scripts > 0
      ? `${plural(scripts, "script is", "scripts are")} recorded on this machine.`
      : fallback;
  }
  const { continue: session, entries } = state.index;
  const count =
    scripts > 0
      ? `${plural(entries.length, "project", "projects")} and ${plural(scripts, "script", "scripts")} are recorded on this machine.`
      : `${plural(entries.length, "project is", "projects are")} indexed on this machine.`;
  return session ? `One run is paused and waiting. ${count}` : count;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/* ── Resume: what this machine can actually do right now ─────────────────── */

/**
 * The runtime restores a checkpoint only into the open session that owns the
 * run (`POST /v2/sessions/current/persistence/checkpoints/{id}/restore`), and
 * only for `exact_resume`. Everything here is therefore derived from the live
 * checkpoint catalog and the live run, never from the `resumable` flag stored
 * in the index file.
 */
export type CheckpointCatalogState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly checkpoints: readonly CheckpointEntry[] };

/** The facts of the open session's run that decide resumability. */
export interface LiveRunFacts {
  readonly runId: string;
  readonly requestedDevice: string;
  readonly resolvedDevice?: string | null;
  readonly resolvedRuntimeFamily?: string | null;
  readonly totalSteps?: number | null;
}

export interface ContinueLiveInput {
  readonly catalog: CheckpointCatalogState;
  readonly run: LiveRunFacts | null;
  readonly compute: ComputeProbeState;
  readonly restoring: boolean;
}

export type ContinueStatus =
  | "resumable"
  | "restoring"
  | "project-closed"
  | "loading"
  | "error"
  | "no-checkpoint"
  | "device-unavailable"
  | "version-mismatch"
  | "index-not-resumable";

/**
 * `enabled`: the action will be attempted. `disabled`: shown with the reason
 * because the state is transient or fixable by opening the project. `hidden`:
 * this machine cannot resume the checkpoint, so the action is removed.
 */
export type ResumeAction =
  | { readonly kind: "enabled"; readonly checkpointId: string }
  | { readonly kind: "disabled"; readonly reason: string }
  | { readonly kind: "hidden" };

export interface ContinueResolution {
  readonly status: ContinueStatus;
  readonly resume: ResumeAction;
  /** Shown in place of the ETA whenever resume is not enabled. */
  readonly reason: string | null;
  /** The session with `resumable` computed here and live progress applied. */
  readonly session: ContinueSession;
}

export const REASON_PROJECT_CLOSED =
  "Open this project to resume the run. A checkpoint is restored into the open session.";
export const REASON_LOADING = "Reading the run's checkpoints from the runtime.";
export const REASON_RESTORING = "Restoring the checkpoint into the open session.";
export const REASON_NO_CHECKPOINT = "The runtime holds no checkpoint for this run.";
export const REASON_NO_GPU =
  "This run requires a GPU and none is available here. Fullmag does not fall back to the CPU.";
export const REASON_GPU_NOT_RESOLVED =
  "This run requires a GPU but the open session did not resolve to one. Fullmag does not fall back to the CPU.";
export const REASON_PROBING = "Checking which compute devices this machine offers.";
export const REASON_FAMILY_MISMATCH =
  "The checkpoint was written by a different runtime realization than the open session and cannot be resumed exactly.";
export const REASON_NOT_EXACT: Readonly<Record<string, string>> = {
  logical_resume:
    "The checkpoint was written by a different build or runtime and cannot be resumed exactly.",
  initial_condition_import:
    "The problem or plan changed since this checkpoint; it can only seed a new run.",
  config_only: "The checkpoint holds no magnetization state to resume from.",
};

const isGpuName = (value: string | null | undefined): boolean =>
  value != null && /gpu|cuda|hip|rocm/i.test(value);

/** The latest checkpoint of the run; ties on time fall back to the step. */
export function latestCheckpoint(
  checkpoints: readonly CheckpointEntry[],
  runId: string,
): CheckpointEntry | null {
  let latest: CheckpointEntry | null = null;
  for (const checkpoint of checkpoints) {
    if (checkpoint.run_id !== runId) continue;
    if (
      latest === null ||
      checkpoint.created_at > latest.created_at ||
      (checkpoint.created_at === latest.created_at && checkpoint.step > latest.step)
    ) {
      latest = checkpoint;
    }
  }
  return latest;
}

function withLiveProgress(
  session: ContinueSession,
  checkpoint: CheckpointEntry,
  totalSteps: number | null | undefined,
): ContinueSession {
  const fraction =
    totalSteps != null && totalSteps > 0
      ? Math.min(Math.max(checkpoint.step / totalSteps, 0), 1)
      : session.progress.fraction;
  return {
    ...session,
    checkpointAt: checkpoint.created_at,
    progress: {
      ...session.progress,
      fraction,
      simTimeS: checkpoint.time_s,
      // The index estimate belongs to an older checkpoint: omit rather than guess.
      etaSeconds: null,
    },
  };
}

/**
 * Decide what the Continue card offers. Pure: the caller supplies the live
 * resources. With no matching open session the card stays on the index
 * session as written and Resume is disabled with the reason.
 */
export function resolveContinue(
  session: ContinueSession,
  live: ContinueLiveInput | null,
): ContinueResolution {
  const settle = (
    status: ContinueStatus,
    resume: ResumeAction,
    reason: string | null,
    next: ContinueSession = session,
  ): ContinueResolution => ({
    status,
    resume,
    reason,
    session: {
      ...next,
      resumable: resume.kind !== "hidden",
      notResumableReason: reason ?? undefined,
    },
  });

  // The index states, in its own words, that this machine cannot resume.
  if (!session.resumable) {
    return {
      status: "index-not-resumable",
      resume: { kind: "hidden" },
      reason: session.notResumableReason ?? "This checkpoint cannot be resumed by this build.",
      session,
    };
  }

  if (live === null || live.run === null || live.run.runId !== session.runId) {
    return settle(
      "project-closed",
      { kind: "disabled", reason: REASON_PROJECT_CLOSED },
      REASON_PROJECT_CLOSED,
    );
  }

  if (live.restoring) {
    return settle("restoring", { kind: "disabled", reason: REASON_RESTORING }, REASON_RESTORING);
  }
  if (live.catalog.kind === "idle" || live.catalog.kind === "loading") {
    return settle("loading", { kind: "disabled", reason: REASON_LOADING }, REASON_LOADING);
  }
  if (live.catalog.kind === "error") {
    const reason = `Could not read the checkpoints: ${live.catalog.message}`;
    return settle("error", { kind: "disabled", reason }, reason);
  }

  const checkpoint = latestCheckpoint(live.catalog.checkpoints, session.runId);
  if (checkpoint === null) {
    return settle("no-checkpoint", { kind: "hidden" }, REASON_NO_CHECKPOINT);
  }
  const progressed = withLiveProgress(session, checkpoint, live.run.totalSteps);

  if (checkpoint.resume_class !== "exact_resume") {
    const reason = REASON_NOT_EXACT[checkpoint.resume_class] ?? REASON_FAMILY_MISMATCH;
    return settle("version-mismatch", { kind: "hidden" }, reason, progressed);
  }
  const family = live.run.resolvedRuntimeFamily;
  if (checkpoint.backend_family && family && checkpoint.backend_family !== family) {
    return settle("version-mismatch", { kind: "hidden" }, REASON_FAMILY_MISMATCH, progressed);
  }

  // Requested intent versus what exists now: a forced GPU is never swapped for the CPU.
  if (isGpuName(live.run.requestedDevice)) {
    if (!isGpuName(live.run.resolvedDevice) && !isGpuName(live.run.resolvedRuntimeFamily)) {
      return settle("device-unavailable", { kind: "hidden" }, REASON_GPU_NOT_RESOLVED, progressed);
    }
    if (live.compute === undefined) {
      return settle(
        "loading",
        { kind: "disabled", reason: REASON_PROBING },
        REASON_PROBING,
        progressed,
      );
    }
    // `null` means this host cannot probe; the open session already holds its device.
    if (live.compute !== null && live.compute.gpuProbeStatus !== "unavailable" &&
      live.compute.gpus.length === 0) {
      return settle("device-unavailable", { kind: "hidden" }, REASON_NO_GPU, progressed);
    }
  }

  return settle(
    "resumable",
    { kind: "enabled", checkpointId: checkpoint.checkpoint_id },
    null,
    progressed,
  );
}

/** Map the checkpoint resource onto the states the card distinguishes. */
export function toCatalogState(resource: {
  readonly data: CheckpointListResource | null;
  readonly status: "idle" | "loading" | "ready" | "stale" | "error";
  readonly error: Error | null;
}): CheckpointCatalogState {
  // A refresh that failed keeps the last confirmed catalog, as the resource layer does.
  if (resource.data) return { kind: "ready", checkpoints: resource.data.checkpoints };
  if (resource.status === "error") {
    return { kind: "error", message: resource.error?.message ?? "the runtime did not answer" };
  }
  if (resource.status === "idle") return { kind: "idle" };
  if (resource.status === "loading") return { kind: "loading" };
  // Ready without data: the runtime has no workspace-scoped catalog (404).
  return { kind: "ready", checkpoints: [] };
}

/** Restoring leaves the session paused, so the caption says what happens. */
export function resumeLabel(status: ContinueStatus): string {
  return status === "restoring" ? "Restoring…" : "Restore checkpoint";
}
