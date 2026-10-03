/**
 * Pure helpers over the recent index: parse, filter, sort, group.
 *
 * Everything here is deliberately free of React and of the Tauri bridge, so it
 * is covered by plain vitest cases — the grouping in particular has edge cases
 * (midnight, DST, a clock that moved backwards) that are painful to reach
 * through the UI.
 *
 * Reference implementation — intended to live at
 * apps/control-room/src/modules/start/model/recentIndex.ts
 */

import type {
  RecentEntry,
  RecentFilter,
  RecentIndex,
  RecentIndexState,
  RecentSort,
} from "./types";

/* ── Parsing ────────────────────────────────────────────────────────────── */

/**
 * Normalise whatever the host handed over. A malformed index is NOT an error
 * worth propagating as a crash: the index is derived state, so the caller is
 * told to rebuild and the user keeps working.
 */
export function parseRecentIndex(raw: unknown): RecentIndexState {
  if (raw == null || typeof raw !== "object") {
    return { kind: "error", message: "The recent-project index is empty or unreadable." };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.format_version !== 1 && obj.formatVersion !== 1) {
    return {
      kind: "error",
      message: `Unsupported index format ${String(obj.format_version ?? obj.formatVersion)}; expected 1.`,
    };
  }
  const entries = obj.entries;
  if (!Array.isArray(entries)) {
    return { kind: "error", message: "The index has no entries array." };
  }
  const parsed = entries.flatMap((e) => {
    const entry = toEntry(e);
    return entry ? [entry] : [];
  });
  if (parsed.length === 0) return { kind: "empty" };

  const index: RecentIndex = {
    formatVersion: 1,
    generatedAt: String(obj.generated_at ?? obj.generatedAt ?? new Date().toISOString()),
    entries: parsed,
    continue: toContinue(obj.continue),
    scannedLocations: Array.isArray(obj.scanned_locations)
      ? (obj.scanned_locations as RecentIndex["scannedLocations"])
      : undefined,
  };
  return { kind: "ready", index };
}

function toEntry(value: unknown): RecentEntry | null {
  if (value == null || typeof value !== "object") return null;
  const e = value as Record<string, any>;
  if (typeof e.project_id !== "string" || typeof e.name !== "string") return null;
  return {
    projectId: e.project_id,
    name: e.name,
    path: String(e.path ?? ""),
    solver: e.solver === "FEM" ? "FEM" : "FDM",
    status: e.status ?? "ready",
    lastOpenedAt: String(e.last_opened_at ?? e.modified_at ?? new Date(0).toISOString()),
    createdAt: e.created_at,
    modifiedAt: e.modified_at,
    sizeBytes: typeof e.size_bytes === "number" ? e.size_bytes : undefined,
    revision: typeof e.revision === "number" ? e.revision : undefined,
    manifestSchemaVersion: e.manifest_schema_version,
    createdWithVersion: e.created_with_version,
    mode: e.mode,
    modeReason: e.mode_reason,
    pinned: Boolean(e.pinned),
    tags: Array.isArray(e.tags) ? e.tags : undefined,
    thumbnail: e.thumbnail,
    lastError: e.last_error,
    summary: e.summary ? toSummary(e.summary) : undefined,
    authors: Array.isArray(e.authors) ? e.authors : undefined,
  };
}

function toSummary(s: Record<string, any>): RecentEntry["summary"] {
  return {
    discretisation: s.discretisation,
    cellSize: s.cell_size,
    periodicity: s.periodicity,
    materials: s.materials,
    ms: s.ms,
    aex: s.aex,
    alpha: s.alpha,
    interactions: s.interactions,
    integrator: s.integrator,
    tolerance: s.tolerance,
    excitation: s.excitation,
    outputFrames: s.output_frames,
    outputBytes: s.output_bytes,
    outputFields: s.output_fields,
  };
}

function toContinue(value: unknown): RecentIndex["continue"] {
  if (value == null || typeof value !== "object") return undefined;
  const c = value as Record<string, any>;
  if (typeof c.project_id !== "string" || c.progress == null) return undefined;
  return {
    projectId: c.project_id,
    runId: String(c.run_id ?? ""),
    checkpointAt: String(c.checkpoint_at ?? ""),
    device: c.device,
    resumable: c.resumable !== false,
    notResumableReason: c.not_resumable_reason,
    progress: {
      fraction: clamp01(Number(c.progress.fraction ?? 0)),
      simTimeS: c.progress.sim_time_s,
      simTimeTotalS: c.progress.sim_time_total_s,
      framesWritten: c.progress.frames_written,
      framesTotal: c.progress.frames_total,
      etaSeconds: c.progress.eta_seconds ?? null,
    },
  };
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/* ── Filtering and sorting ──────────────────────────────────────────────── */

export function filterEntries(
  entries: readonly RecentEntry[],
  filter: RecentFilter,
  query: string,
): RecentEntry[] {
  const q = query.trim().toLowerCase();
  return entries.filter((e) => {
    if (filter === "fdm" && e.solver !== "FDM") return false;
    if (filter === "fem" && e.solver !== "FEM") return false;
    if (filter === "pinned" && !e.pinned) return false;
    if (!q) return true;
    const haystack = `${e.name} ${e.path} ${(e.tags ?? []).join(" ")} ${e.solver}`.toLowerCase();
    return haystack.includes(q);
  });
}

export function sortEntries(entries: readonly RecentEntry[], sort: RecentSort): RecentEntry[] {
  const out = [...entries];
  switch (sort) {
    case "name":
      // localeCompare so "µMAG" and "Śmigło" land where a human expects them.
      return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    case "size":
      return out.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
    case "created":
      return out.sort((a, b) => time(b.createdAt) - time(a.createdAt));
    case "lastRun":
    case "lastOpened":
    default:
      return out.sort((a, b) => time(b.lastOpenedAt) - time(a.lastOpenedAt));
  }
}

const time = (iso?: string) => {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/* ── Grouping ───────────────────────────────────────────────────────────── */

export type RecentGroupId = "pinned" | "today" | "yesterday" | "week" | "older";

export interface RecentGroup {
  readonly id: RecentGroupId;
  readonly label: string;
  readonly entries: readonly RecentEntry[];
}

const GROUP_LABELS: Record<RecentGroupId, string> = {
  pinned: "Pinned",
  today: "Today",
  yesterday: "Yesterday",
  week: "Earlier this week",
  older: "Older",
};

/**
 * Group by recency relative to `now`.
 *
 * Boundaries are LOCAL calendar days, not 24-hour windows: something opened at
 * 23:50 yesterday is "Yesterday" at 00:10 today, not "Today". Comparing
 * day-start timestamps rather than subtracting fixed millisecond amounts also
 * keeps this correct across a DST change, where a local day is 23 or 25 hours.
 *
 * Pinned entries are hoisted out of their date group entirely — a pinned
 * project is one you want at the top, which is the whole point of pinning it.
 */
export function groupByRecency(
  entries: readonly RecentEntry[],
  now: Date = new Date(),
): RecentGroup[] {
  const startOfToday = startOfDay(now);
  const startOfYesterday = addDays(startOfToday, -1);
  const startOfWeek = addDays(startOfToday, -6);

  const buckets: Record<RecentGroupId, RecentEntry[]> = {
    pinned: [], today: [], yesterday: [], week: [], older: [],
  };

  for (const entry of entries) {
    if (entry.pinned) {
      buckets.pinned.push(entry);
      continue;
    }
    const t = time(entry.lastOpenedAt);
    // A timestamp in the future (clock skew, a file copied from another
    // machine) sorts as "today" rather than falling through to "older".
    if (t >= startOfToday.getTime()) buckets.today.push(entry);
    else if (t >= startOfYesterday.getTime()) buckets.yesterday.push(entry);
    else if (t >= startOfWeek.getTime()) buckets.week.push(entry);
    else buckets.older.push(entry);
  }

  return (Object.keys(buckets) as RecentGroupId[])
    .filter((id) => buckets[id].length > 0)
    .map((id) => ({ id, label: GROUP_LABELS[id], entries: buckets[id] }));
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  out.setHours(0, 0, 0, 0);
  return out;
}

/* ── Formatting ─────────────────────────────────────────────────────────── */

export function formatBytes(bytes: number | undefined, locale?: string): string {
  if (bytes == null) return "—";
  const nf = (v: number, d: number) =>
    new Intl.NumberFormat(locale, { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
  if (bytes >= 1e9) return `${nf(bytes / 1e9, 2)} GB`;
  if (bytes >= 1e6) return `${nf(bytes / 1e6, 0)} MB`;
  if (bytes >= 1e3) return `${nf(bytes / 1e3, 0)} kB`;
  return `${bytes} B`;
}

/** Relative inside the week, absolute beyond it — see the copy rules. */
export function formatOpened(iso: string, now: Date = new Date(), locale?: string): string {
  const t = time(iso);
  if (!t) return "—";
  const d = new Date(t);
  const startOfToday = startOfDay(now);
  const hm = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(d);
  if (t >= startOfToday.getTime()) return `today ${hm}`;
  if (t >= addDays(startOfToday, -1).getTime()) return `yesterday ${hm}`;
  if (t >= addDays(startOfToday, -6).getTime()) {
    return `${new Intl.DateTimeFormat(locale, { weekday: "short" }).format(d)} ${hm}`;
  }
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(d);
}

export function formatEta(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 90) return `≈ ${Math.round(seconds)} s`;
  if (seconds < 5400) return `≈ ${Math.round(seconds / 60)} min`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m ? `≈ ${h} h ${m} min` : `≈ ${h} h`;
}

/** Shorten a host path for a narrow column, keeping the file name intact. */
export function shortenPath(path: string, maxSegments = 3): string {
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(sep).filter(Boolean);
  if (parts.length <= maxSegments) return path;
  return `…${sep}${parts.slice(-maxSegments).join(sep)}`;
}
