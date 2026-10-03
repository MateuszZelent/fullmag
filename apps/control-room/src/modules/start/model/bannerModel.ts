import { formatEta } from "./recentIndex";
import type { ContinueSession, RecentEntry } from "./types";

export type BannerTone = "info" | "warning" | "danger";
export type BannerIcon = "activity" | "alert" | "link" | "refresh";

export interface BannerAction {
  readonly id: string;
  readonly label: string;
}

export interface BannerModel {
  readonly id: "missing" | "running" | "failed" | "migrate" | "readonly";
  readonly tone: BannerTone;
  readonly icon: BannerIcon;
  readonly title: string;
  readonly body: string;
  readonly detail?: string;
  readonly actions: readonly BannerAction[];
}

export interface SelectBannerInput {
  readonly entry: RecentEntry;
  readonly session?: ContinueSession;
  readonly migrationSteps?: readonly string[];
  readonly supportedSchemaVersion?: string;
}

/**
 * At most one banner, chosen here rather than in JSX so a new condition cannot
 * quietly stack a second one. Status is single-valued, so the only real overlap
 * is the read-only mode, which therefore ranks last. Priority, highest first:
 * file missing, run in progress, last run failed, migration required, read-only.
 */
export function selectBanner(input: SelectBannerInput): BannerModel | null {
  const { entry, session } = input;

  if (entry.status === "missing") {
    return {
      id: "missing",
      tone: "danger",
      icon: "alert",
      title: "The file is no longer at this path.",
      body: "It may have been moved or renamed, or the drive may be disconnected.",
      detail: entry.path,
      actions: [{ id: "forget", label: "Remove from recent" }],
    };
  }

  if (entry.status === "running" && session && session.projectId === entry.projectId) {
    const pct = Math.round(session.progress.fraction * 100);
    const eta = formatEta(session.progress.etaSeconds);
    const where =
      session.progress.simTimeS != null && session.progress.simTimeTotalS != null
        ? `t = ${(session.progress.simTimeS * 1e9).toFixed(2)} ns of ${(session.progress.simTimeTotalS * 1e9).toFixed(2)} ns`
        : `${session.progress.framesWritten ?? 0} of ${session.progress.framesTotal ?? "?"} frames`;
    return {
      id: "running",
      tone: "warning",
      icon: "activity",
      title: `Run in progress — ${pct}%.`,
      body:
        [where, session.device ? `on ${session.device}` : null, eta ? `${eta} remaining` : null]
          .filter(Boolean)
          .join("; ") + ".",
      actions: [],
    };
  }

  if (entry.status === "failed" && entry.lastError) {
    return {
      id: "failed",
      tone: "danger",
      icon: "alert",
      title: "Last run failed.",
      // Verbatim from the solver: cause, number, suggestion. Never "see log".
      body: entry.lastError,
      actions: [],
    };
  }

  if (entry.status === "migrate") {
    const from = entry.manifestSchemaVersion ?? "older";
    const to = input.supportedSchemaVersion ?? "current";
    return {
      id: "migrate",
      tone: "warning",
      icon: "refresh",
      title: `Archive schema ${from} → ${to}.`,
      body: "Opening migrates a copy; the original file is left untouched.",
      detail: input.migrationSteps?.join(" · "),
      actions: [],
    };
  }

  if (entry.mode === "read_only") {
    return {
      id: "readonly",
      tone: "info",
      icon: "link",
      title: "Read-only.",
      body: entry.modeReason ?? "This project cannot be modified in place.",
      actions: [],
    };
  }

  return null;
}

/** The primary button names what Open will really do for this project. */
export function openLabel(entry: RecentEntry): string {
  if (entry.status === "migrate") return "Migrate & open";
  if (entry.status === "running") return "Open running project";
  return "Open project";
}
