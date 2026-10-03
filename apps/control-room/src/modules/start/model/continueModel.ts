import { formatEta } from "./recentIndex";
import type { ContinueSession, RecentIndexState } from "./types";

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
export function homeSubline(state: RecentIndexState): string {
  const fallback = "Start from an empty FDM or FEM problem, or open a project archive.";
  if (state.kind !== "ready") return fallback;
  const { continue: session, entries } = state.index;
  const count = `${entries.length} ${entries.length === 1 ? "project is" : "projects are"} indexed on this machine.`;
  return session ? `One run is paused and waiting. ${count}` : count;
}
