import { formatEta } from "./recentIndex";
import type { ContinueSession, RecentEntry } from "./types";

export type BannerTone = "info" | "warning" | "danger";
export type BannerIcon = "activity" | "alert" | "link" | "refresh";

export interface BannerAction {
  readonly id: string;
  readonly label: string;
}

export interface BannerModel {
  readonly id:
    | "missing"
    | "running"
    | "paused"
    | "failed"
    | "migrate"
    | "readonly"
    | "unreadable"
    | "syntax"
    | "incomplete";
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
  /** Why the backend could not read the file's details; the row's facts still show. */
  readonly readError?: string;
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

  // A checkpoint of this project is waiting and nothing is running: say so, and
  // that opening the project is how it is resumed.
  if (session && session.projectId === entry.projectId && entry.status !== "running") {
    const pct = Math.round(session.progress.fraction * 100);
    return {
      id: "paused",
      tone: "warning",
      icon: "activity",
      title: `Run paused — ${pct}%.`,
      body: "A checkpoint is waiting. Open the project to resume the run from it.",
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

  return input.readError ? unreadableBanner(input.readError) : null;
}

function unreadableBanner(reason: string): BannerModel {
  return {
    id: "unreadable",
    tone: "warning",
    icon: "alert",
    title: "The file could not be read.",
    body: "The facts from the list are shown; the details are not available.",
    detail: reason,
    actions: [],
  };
}

export interface ScriptBannerInput {
  readonly status: RecentEntry["status"];
  readonly path: string;
  readonly syntax?: { readonly ok: boolean; readonly line?: number; readonly message?: string };
  readonly readError?: string;
}

/** A script's banner: the file is gone, it does not parse, or it could not be read. */
export function selectScriptBanner(input: ScriptBannerInput): BannerModel | null {
  if (input.status === "missing") {
    return {
      id: "missing",
      tone: "warning",
      icon: "alert",
      title: "The file is missing.",
      body: "It is no longer at this path. Remove it from recent, or move it back.",
      detail: input.path,
      actions: [],
    };
  }
  if (input.syntax && !input.syntax.ok) {
    const where = input.syntax.line !== undefined ? ` at line ${input.syntax.line}` : "";
    return {
      id: "syntax",
      tone: "danger",
      icon: "alert",
      title: `Syntax error${where}.`,
      // Verbatim from Python: the message is the diagnosis.
      body: input.syntax.message ?? "Python could not parse the script, so a run would stop before it starts.",
      actions: [],
    };
  }
  return input.readError ? unreadableBanner(input.readError) : null;
}

export interface ResultBannerInput {
  readonly status: RecentEntry["status"];
  readonly path: string;
  readonly runStatus?: string;
  readonly readError?: string;
}

/** A result folder's banner: gone, still being written, failed, ended early, or unreadable. */
export function selectResultBanner(input: ResultBannerInput): BannerModel | null {
  if (input.status === "missing") {
    return {
      id: "missing",
      tone: "danger",
      icon: "alert",
      title: "The folder is no longer at this path.",
      body: "It may have been moved or deleted, or the drive may be disconnected.",
      detail: input.path,
      actions: [{ id: "forget", label: "Remove from recent" }],
    };
  }
  const run = input.runStatus?.toLowerCase();
  if (run === "running") {
    return {
      id: "running",
      tone: "warning",
      icon: "activity",
      title: "A run is writing this folder.",
      body: "Sizes and stages will change until it finishes.",
      actions: [],
    };
  }
  if (run === "failed" || run === "error" || input.status === "failed") {
    return {
      id: "failed",
      tone: "danger",
      icon: "alert",
      title: "The run that wrote this folder failed.",
      body: "What it wrote before stopping is still listed below.",
      actions: [],
    };
  }
  if (run === "partial" || run === "incomplete" || run === "cancelled" || run === "canceled") {
    return {
      id: "incomplete",
      tone: "warning",
      icon: "alert",
      title: "The run ended before it finished.",
      body: "Only the stages it completed are listed below.",
      actions: [],
    };
  }
  return input.readError ? unreadableBanner(input.readError) : null;
}

/** The primary button names what Open will really do for this project. */
export function openLabel(entry: RecentEntry): string {
  if (entry.status === "migrate") return "Migrate & open";
  if (entry.status === "running") return "Open running project";
  return "Open project";
}
