/** Pure wire DTOs and runtime parsers for the HTTP workspace database. */

export type ApiItemKind = "project" | "script" | "result";
export type ApiKindFilter = "all" | ApiItemKind;

export type WorkspaceItemStatus = "ready" | "missing" | "failed" | "migrate" | "readonly";

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

export type ApiThumbnailOrigin = "item" | "source_project";

export interface ApiWorkspaceItem {
  readonly id: string;
  readonly kind: ApiItemKind;
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
  /** Kind specific facts; read through the accessors below, never assumed. */
  readonly meta: Readonly<Record<string, unknown>>;
  readonly hasThumbnail: boolean;
  /** The source of a thumbnail, when the backend provides one. */
  readonly thumbnailOrigin?: ApiThumbnailOrigin;
}

export interface ApiWorkspaceList {
  readonly items: readonly ApiWorkspaceItem[];
  readonly outcome: WorkspaceOutcome;
  /** Items without a usable identity; left out and counted. */
  readonly skipped: number;
}

type Raw = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Raw =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const invalid = (what: string): Error =>
  new Error(`The backend returned an unexpected ${what}.`);

const KINDS: readonly ApiItemKind[] = ["project", "script", "result"];
const STATUSES: readonly WorkspaceItemStatus[] = ["ready", "missing", "failed", "migrate", "readonly"];
const OUTCOMES: readonly WorkspaceOutcomeState[] = [
  "ready",
  "created",
  "migrated",
  "quarantined",
  "read_only_newer_schema",
];
const THUMBNAIL_ORIGINS: readonly ApiThumbnailOrigin[] = ["item", "source_project"];

/** The item, or null when it lacks the identity a row cannot do without. */
export function parseApiWorkspaceItem(value: unknown): ApiWorkspaceItem | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" && value.id !== "" ? value.id : undefined;
  const kind = KINDS.find((candidate) => candidate === value.kind);
  if (!id || !kind || typeof value.path !== "string" || typeof value.name !== "string") return null;
  return {
    id,
    kind,
    path: value.path,
    name: value.name,
    projectId: str(value.project_id),
    firstSeenAt: str(value.first_seen_at) ?? "",
    lastUsedAt: str(value.last_used_at) ?? "",
    useCount: Math.max(0, Math.trunc(num(value.use_count) ?? 0)),
    pinned: value.pinned === true,
    status: STATUSES.find((status) => status === value.status) ?? "ready",
    sizeBytes: num(value.size_bytes),
    modifiedAt: str(value.modified_at),
    meta: isRecord(value.meta) ? value.meta : {},
    hasThumbnail: value.has_thumbnail === true,
    thumbnailOrigin: THUMBNAIL_ORIGINS.find((origin) => origin === value.thumbnail_origin),
  };
}

function parseOutcome(value: unknown): WorkspaceOutcome {
  if (!isRecord(value)) throw invalid("workspace outcome");
  const state = OUTCOMES.find((candidate) => candidate === value.state);
  if (!state) throw invalid("workspace outcome state");
  return { state, detail: str(value.detail) };
}

/**
 * The envelope must be right or the whole answer is rejected; malformed or
 * duplicate items are skipped and counted, so one bad row never hides the rest.
 */
export function parseApiWorkspaceList(raw: unknown): ApiWorkspaceList {
  if (!isRecord(raw) || !Array.isArray(raw.items)) throw invalid("workspace list");
  const outcome = parseOutcome(raw.outcome);
  const seen = new Set<string>();
  const items: ApiWorkspaceItem[] = [];
  let skipped = 0;
  for (const value of raw.items) {
    const item = parseApiWorkspaceItem(value);
    if (!item || seen.has(item.id)) {
      skipped += 1;
      continue;
    }
    seen.add(item.id);
    items.push(item);
  }
  return { items, outcome, skipped };
}
