/**
 * Pure helpers over the recent index: parse, filter, sort, group, format.
 *
 * Free of React and of the host bridge so plain vitest cases cover the parts
 * that are invisible in a screenshot: local-midnight grouping, DST, a clock
 * that moved backwards, pinned hoisting and truncated indexes.
 */

import type {
  Author,
  ContinueSession,
  DocumentMode,
  ModelSummary,
  ProjectStatus,
  RecentEntry,
  RecentFilter,
  RecentIndex,
  RecentIndexState,
  RecentSort,
} from "./types";

type Raw = Readonly<Record<string, unknown>>;

const STATUSES: readonly ProjectStatus[] = [
  "ready",
  "running",
  "failed",
  "draft",
  "migrate",
  "missing",
  "readonly",
];

const isRecord = (value: unknown): value is Raw =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const optString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const optNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const optStrings = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Normalise whatever the host handed over. A malformed index is not a crash:
 * the caller is told to rebuild and the user keeps working. Entries that lack
 * an identity are skipped individually, so one bad row never hides the rest.
 */
export function parseRecentIndex(raw: unknown): RecentIndexState {
  if (!isRecord(raw)) {
    return { kind: "error", message: "The recent-project index is empty or unreadable." };
  }
  const version = raw.format_version ?? raw.formatVersion;
  if (version !== 1) {
    return {
      kind: "error",
      message: `Unsupported index format ${String(version)}; expected 1.`,
    };
  }
  if (!Array.isArray(raw.entries)) {
    return { kind: "error", message: "The index has no entries array." };
  }
  const seen = new Set<string>();
  const entries: RecentEntry[] = [];
  for (const value of raw.entries) {
    const entry = toEntry(value);
    // The list de-duplicates on the stable project id.
    if (!entry || seen.has(entry.projectId)) continue;
    seen.add(entry.projectId);
    entries.push(entry);
  }
  if (entries.length === 0) return { kind: "empty" };

  const locations = raw.scanned_locations;
  const index: RecentIndex = {
    formatVersion: 1,
    generatedAt: optString(raw.generated_at ?? raw.generatedAt) ?? new Date(0).toISOString(),
    entries,
    continue: toContinue(raw.continue),
    scannedLocations: Array.isArray(locations)
      ? locations.filter(isRecord).map((l) => ({
          path: String(l.path ?? ""),
          recursive: typeof l.recursive === "boolean" ? l.recursive : undefined,
          lastScannedAt: optString(l.last_scanned_at),
          reachable: typeof l.reachable === "boolean" ? l.reachable : undefined,
        }))
      : undefined,
  };
  return { kind: "ready", index };
}

function toEntry(value: unknown): RecentEntry | null {
  if (!isRecord(value)) return null;
  if (typeof value.project_id !== "string" || typeof value.name !== "string") return null;
  const status = STATUSES.find((s) => s === value.status) ?? "ready";
  const mode: DocumentMode | undefined =
    value.mode === "read_only" || value.mode === "read_write" ? value.mode : undefined;
  return {
    projectId: value.project_id,
    name: value.name,
    path: optString(value.path) ?? "",
    solver: value.solver === "FEM" ? "FEM" : "FDM",
    status,
    lastOpenedAt:
      optString(value.last_opened_at) ?? optString(value.modified_at) ?? new Date(0).toISOString(),
    createdAt: optString(value.created_at),
    modifiedAt: optString(value.modified_at),
    sizeBytes: optNumber(value.size_bytes),
    revision: optNumber(value.revision),
    manifestSchemaVersion: optString(value.manifest_schema_version),
    createdWithVersion: optString(value.created_with_version),
    mode,
    modeReason: optString(value.mode_reason),
    pinned: value.pinned === true,
    tags: optStrings(value.tags),
    thumbnail: optString(value.thumbnail),
    lastError: optString(value.last_error),
    summary: isRecord(value.summary) ? toSummary(value.summary) : undefined,
    authors: Array.isArray(value.authors)
      ? value.authors.filter(isRecord).map(toAuthor)
      : undefined,
  };
}

function toAuthor(a: Raw): Author {
  const role = a.role === "maintainer" || a.role === "contributor" ? a.role : "creator";
  return {
    name: String(a.name ?? ""),
    email: optString(a.email),
    affiliation: optString(a.affiliation),
    orcid: optString(a.orcid),
    role,
  };
}

function toSummary(s: Raw): ModelSummary {
  return {
    discretisation: optString(s.discretisation),
    cellSize: optString(s.cell_size),
    periodicity: optString(s.periodicity),
    materials: optStrings(s.materials),
    ms: optString(s.ms),
    aex: optString(s.aex),
    alpha: optString(s.alpha),
    interactions: optStrings(s.interactions),
    integrator: optString(s.integrator),
    tolerance: optString(s.tolerance),
    excitation: optString(s.excitation),
    outputFrames: optNumber(s.output_frames),
    outputBytes: optNumber(s.output_bytes),
    outputFields: optStrings(s.output_fields),
  };
}

function toContinue(value: unknown): ContinueSession | undefined {
  if (!isRecord(value) || typeof value.project_id !== "string" || !isRecord(value.progress)) {
    return undefined;
  }
  const p = value.progress;
  return {
    projectId: value.project_id,
    runId: String(value.run_id ?? ""),
    checkpointAt: String(value.checkpoint_at ?? ""),
    device: optString(value.device),
    resumable: value.resumable !== false,
    notResumableReason: optString(value.not_resumable_reason),
    progress: {
      fraction: clamp01(Number(p.fraction ?? 0)),
      simTimeS: optNumber(p.sim_time_s),
      simTimeTotalS: optNumber(p.sim_time_total_s),
      framesWritten: optNumber(p.frames_written),
      framesTotal: optNumber(p.frames_total),
      etaSeconds: optNumber(p.eta_seconds) ?? null,
    },
  };
}

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

const time = (iso?: string) => {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

export function sortEntries(entries: readonly RecentEntry[], sort: RecentSort): RecentEntry[] {
  const out = [...entries];
  switch (sort) {
    case "name":
      // localeCompare so non-ASCII names land where a human expects them.
      return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    case "size":
      return out.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
    case "created":
      return out.sort((a, b) => time(b.createdAt) - time(a.createdAt));
    case "lastOpened":
      return out.sort((a, b) => time(b.lastOpenedAt) - time(a.lastOpenedAt));
  }
}

/* ── Grouping ───────────────────────────────────────────────────────────── */

export type RecentGroupId = "pinned" | "today" | "yesterday" | "week" | "older";

export interface RecentGroup {
  readonly id: RecentGroupId;
  readonly label: string;
  readonly entries: readonly RecentEntry[];
}

const GROUP_LABELS: Readonly<Record<RecentGroupId, string>> = {
  pinned: "Pinned",
  today: "Today",
  yesterday: "Yesterday",
  week: "Earlier this week",
  older: "Older",
};

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

/**
 * Group by recency relative to `now`. Boundaries are local calendar days, not
 * 24-hour windows: 23:50 yesterday is "Yesterday" at 00:10, and comparing
 * day-start timestamps stays correct across a DST change. Pinned entries are
 * hoisted out of their date group. Input order is preserved inside a group.
 */
export function groupByRecency(
  entries: readonly RecentEntry[],
  now: Date = new Date(),
): RecentGroup[] {
  const startOfToday = startOfDay(now);
  const startOfYesterday = addDays(startOfToday, -1);
  const startOfWeek = addDays(startOfToday, -6);

  const buckets: Record<RecentGroupId, RecentEntry[]> = {
    pinned: [],
    today: [],
    yesterday: [],
    week: [],
    older: [],
  };

  for (const entry of entries) {
    if (entry.pinned) {
      buckets.pinned.push(entry);
      continue;
    }
    const t = time(entry.lastOpenedAt);
    // A future timestamp (clock skew, a file copied from another machine)
    // reads as "today" rather than falling through to "older".
    if (t >= startOfToday.getTime()) buckets.today.push(entry);
    else if (t >= startOfYesterday.getTime()) buckets.yesterday.push(entry);
    else if (t >= startOfWeek.getTime()) buckets.week.push(entry);
    else buckets.older.push(entry);
  }

  return (Object.keys(buckets) as RecentGroupId[])
    .filter((id) => buckets[id].length > 0)
    .map((id) => ({ id, label: GROUP_LABELS[id], entries: buckets[id] }));
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

/** Relative inside the week, absolute beyond it. */
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
