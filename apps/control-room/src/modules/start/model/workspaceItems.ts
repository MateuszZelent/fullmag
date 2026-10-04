/**
 * Shapes and validation for the desktop host's workspace database
 * (docs/design/start-screen/docs/07-workspace-database.md, section 8).
 *
 * Pure and free of the host bridge: the adapter feeds raw `invoke` results
 * through these parsers, so a host that answers with something unexpected is
 * rejected here with a typed error instead of leaking `undefined` into rows.
 */

export type WorkspaceKind = "project" | "script";

export type WorkspaceItemStatus = "ready" | "missing" | "failed" | "migrate" | "readonly";

export interface WorkspaceLastRun {
  readonly status: string;
  readonly at: string;
  readonly durationSeconds?: number;
  readonly device?: string;
}

export interface WorkspaceItemMeta {
  readonly lines?: number;
  readonly summary?: string;
  readonly usesFullmag?: boolean;
  /** The host read only a prefix of a very large file when it counted lines. */
  readonly truncated?: boolean;
  readonly lastRun?: WorkspaceLastRun;
}

export interface WorkspaceItem {
  readonly id: number;
  readonly kind: WorkspaceKind;
  readonly path: string;
  readonly name: string;
  readonly projectId?: string;
  readonly firstSeenAt: string;
  readonly lastUsedAt: string;
  readonly useCount: number;
  readonly pinned: boolean;
  readonly status: WorkspaceItemStatus;
  readonly sizeBytes?: number;
  readonly modifiedAt?: string;
  readonly meta: WorkspaceItemMeta;
}

export type WorkspaceOutcomeState =
  | "ready"
  | "created"
  | "migrated"
  | "quarantined"
  | "read_only_newer_schema";

export interface WorkspaceOutcome {
  readonly state: WorkspaceOutcomeState;
  readonly detail?: string;
}

export interface WorkspaceList {
  readonly items: readonly WorkspaceItem[];
  readonly outcome: WorkspaceOutcome;
  /** Items the host sent that did not have a usable identity; they are left out. */
  readonly skipped: number;
}

export type WorkspaceEventKind =
  | "open"
  | "save"
  | "run"
  | "create"
  | "import"
  | "pin"
  | "unpin"
  | "forget";

export interface WorkspaceEvent {
  /** Unique within one answer, for React; derived, not sent by the host. */
  readonly key: string;
  readonly at: string;
  readonly kind: WorkspaceEventKind;
  readonly actor: string;
  readonly detail: string;
}

export interface WorkspaceScriptText {
  readonly name: string;
  readonly path: string;
  readonly sha256: string;
  readonly text: string;
}

/** Why a host call did not produce a usable answer. */
export type WorkspaceHostErrorCode =
  /** No desktop host: the browser build. Not a fault. */
  | "unavailable"
  /** A host that predates the workspace commands. */
  | "command_missing"
  /** The host answered with something that is not the documented shape. */
  | "invalid_response"
  /** The host reported a failure of its own. */
  | "host_error";

export class WorkspaceHostError extends Error {
  readonly code: WorkspaceHostErrorCode;

  constructor(code: WorkspaceHostErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceHostError";
    this.code = code;
  }
}

type Raw = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Raw =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const optString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const optNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const ITEM_STATUSES: readonly WorkspaceItemStatus[] = [
  "ready",
  "missing",
  "failed",
  "migrate",
  "readonly",
];

const OUTCOME_STATES: readonly WorkspaceOutcomeState[] = [
  "ready",
  "created",
  "migrated",
  "quarantined",
  "read_only_newer_schema",
];

const EVENT_KINDS: readonly WorkspaceEventKind[] = [
  "open",
  "save",
  "run",
  "create",
  "import",
  "pin",
  "unpin",
  "forget",
];

const invalid = (what: string): WorkspaceHostError =>
  new WorkspaceHostError("invalid_response", `The host returned an unexpected ${what}.`);

function parseLastRun(value: unknown): WorkspaceLastRun | undefined {
  if (!isRecord(value) || typeof value.status !== "string") return undefined;
  return {
    status: value.status,
    at: optString(value.at) ?? "",
    durationSeconds: optNumber(value.duration_seconds),
    device: optString(value.device),
  };
}

function parseMeta(value: unknown): WorkspaceItemMeta {
  if (!isRecord(value)) return {};
  return {
    lines: optNumber(value.lines),
    summary: optString(value.summary),
    usesFullmag: typeof value.uses_fullmag === "boolean" ? value.uses_fullmag : undefined,
    truncated: typeof value.truncated === "boolean" ? value.truncated : undefined,
    lastRun: parseLastRun(value.last_run),
  };
}

/** One item, or null when it lacks the identity a row cannot do without. */
export function parseWorkspaceItem(value: unknown): WorkspaceItem | null {
  if (!isRecord(value)) return null;
  const { id, kind, path, name } = value;
  if (typeof id !== "number" || !Number.isInteger(id)) return null;
  if (kind !== "project" && kind !== "script") return null;
  if (typeof path !== "string" || typeof name !== "string") return null;
  const status = ITEM_STATUSES.find((s) => s === value.status) ?? "ready";
  return {
    id,
    kind,
    path,
    name,
    projectId: optString(value.project_id),
    firstSeenAt: optString(value.first_seen_at) ?? "",
    lastUsedAt: optString(value.last_used_at) ?? "",
    useCount: Math.max(0, Math.trunc(optNumber(value.use_count) ?? 0)),
    pinned: value.pinned === true,
    status,
    sizeBytes: optNumber(value.size_bytes),
    modifiedAt: optString(value.modified_at),
    meta: parseMeta(value.meta),
  };
}

/** A single item answer (open, dialog). Anything else is rejected. */
export function parseWorkspaceItemResponse(raw: unknown): WorkspaceItem {
  const item = parseWorkspaceItem(raw);
  if (!item) throw invalid("workspace item");
  return item;
}

function parseOutcome(value: unknown): WorkspaceOutcome {
  if (!isRecord(value)) throw invalid("workspace outcome");
  const state = OUTCOME_STATES.find((s) => s === value.state);
  if (!state) throw invalid("workspace outcome state");
  return { state, detail: optString(value.detail) };
}

/**
 * The list answer. The envelope must be right or the whole answer is
 * rejected; a single malformed item is skipped (and counted) so one bad row
 * never hides the rest.
 */
export function parseWorkspaceList(raw: unknown): WorkspaceList {
  if (!isRecord(raw) || !Array.isArray(raw.items)) throw invalid("workspace list");
  const outcome = parseOutcome(raw.outcome);
  const seen = new Set<number>();
  const items: WorkspaceItem[] = [];
  let skipped = 0;
  for (const value of raw.items) {
    const item = parseWorkspaceItem(value);
    if (!item || seen.has(item.id)) {
      skipped += 1;
      continue;
    }
    seen.add(item.id);
    items.push(item);
  }
  return { items, outcome, skipped };
}

/** Keys worth showing from an event's free-form detail, in reading order. */
const DETAIL_KEYS = ["status", "revision", "duration_seconds", "device", "source"] as const;

/**
 * The host stores `detail` as JSON text; it may arrive as that text or as an
 * object. Only a short, known subset is shown, never arbitrary content.
 */
export function describeEventDetail(raw: unknown): string {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return "";
    }
  }
  if (!isRecord(value)) return "";
  const parts: string[] = [];
  for (const key of DETAIL_KEYS) {
    const item = value[key];
    if (typeof item === "string" && item) parts.push(item);
    else if (typeof item === "number" && Number.isFinite(item)) {
      parts.push(
        key === "duration_seconds" ? `${item} s` : key === "revision" ? `rev ${item}` : String(item),
      );
    }
  }
  return parts.join(" · ");
}

export function parseWorkspaceHistory(raw: unknown): readonly WorkspaceEvent[] {
  if (!isRecord(raw) || !Array.isArray(raw.events)) throw invalid("workspace history");
  const events: WorkspaceEvent[] = [];
  const occurrences = new Map<string, number>();
  for (const value of raw.events) {
    if (!isRecord(value) || typeof value.at !== "string") continue;
    const kind = EVENT_KINDS.find((k) => k === value.kind);
    if (!kind) continue;
    const actor = optString(value.actor) ?? "";
    const detail = describeEventDetail(value.detail);
    const identity = `${value.at}|${kind}|${actor}|${detail}`;
    const seen = occurrences.get(identity) ?? 0;
    occurrences.set(identity, seen + 1);
    events.push({ key: `${identity}|${seen}`, at: value.at, kind, actor, detail });
  }
  return events;
}

export function parseWorkspaceScriptText(raw: unknown): WorkspaceScriptText {
  if (!isRecord(raw) || typeof raw.text !== "string") throw invalid("script text");
  return {
    name: optString(raw.name) ?? "",
    path: optString(raw.path) ?? "",
    sha256: optString(raw.sha256) ?? "",
    text: raw.text,
  };
}

/** `null` is a cancelled dialog; anything else must be a real item. */
export function parseWorkspaceDialogResponse(raw: unknown): WorkspaceItem | null {
  if (raw === null || raw === undefined) return null;
  return parseWorkspaceItemResponse(raw);
}
