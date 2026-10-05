/**
 * Wire shapes and parsers of the workspace database as the backend serves it
 * over HTTP (GET /v2/workspace/items, /items/{id}, /roots, POST /scan, ...).
 *
 * The routes are hand-declared in the typed client (`api.workspace`) and these
 * types are hand-written until the generated OpenAPI types describe them; when
 * they do, replace the interfaces below with the generated ones and keep the
 * parsers as the runtime check. Every field marked optional may be absent: a
 * parser never throws on a missing optional field, it leaves it `undefined`,
 * and the view renders "unavailable" for that field. Only an item without an
 * identity (id, kind, path, name) is rejected, and a list skips and counts it.
 */

import {
  parseProvenance,
  type Citation,
  type HistoryEntry,
  type Provenance,
  type RunRecord,
} from "./provenance";
import type { Author } from "./types";
import {
  WorkspaceHostError,
  type WorkspaceItemStatus,
  type WorkspaceLastRun,
  type WorkspaceOutcome,
  type WorkspaceOutcomeState,
} from "./workspaceItems";

export type ApiItemKind = "project" | "script" | "result";
export type ApiKindFilter = "all" | ApiItemKind;

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
  /**
   * Whose image the thumbnail is. A result folder only ever shows
   * `source_project`: the stored preview of the project that produced it, not
   * a render of the result.
   */
  readonly thumbnailOrigin?: ApiThumbnailOrigin;
}

export type ApiThumbnailOrigin = "item" | "source_project";
const THUMBNAIL_ORIGINS: readonly ApiThumbnailOrigin[] = ["item", "source_project"];

export interface ApiWorkspaceList {
  readonly items: readonly ApiWorkspaceItem[];
  readonly outcome: WorkspaceOutcome;
  /** Items without a usable identity; left out and counted. */
  readonly skipped: number;
}

/* ── Details ────────────────────────────────────────────────────────────── */

export interface ProjectModelSummary {
  readonly discretisation?: string;
  readonly cell?: string;
  readonly periodicity?: string;
  readonly materials?: readonly string[];
  readonly ms?: string;
  readonly aex?: string;
  readonly alpha?: string;
  readonly interactions?: readonly string[];
}

export interface ProjectExecutionSummary {
  readonly integrator?: string;
  readonly tolerance?: string;
  readonly excitation?: string;
}

export interface ProjectOutputsSummary {
  readonly frames?: number;
  readonly sizeBytes?: number;
}

export interface ProjectDetail {
  readonly kind: "project";
  readonly schemaVersion?: string;
  readonly revision?: number;
  readonly solver?: string;
  readonly migrated?: boolean;
  readonly canWrite?: boolean;
  readonly mode?: string;
  readonly warnings: readonly string[];
  readonly summary?: {
    readonly model: ProjectModelSummary;
    readonly execution: ProjectExecutionSummary;
    readonly outputs: ProjectOutputsSummary;
  };
  readonly authors: readonly Author[];
  readonly citation: Citation;
  readonly history: readonly HistoryEntry[];
  readonly runs: readonly RunRecord[];
  readonly previewColouring?: string;
  readonly readError?: string;
}

export interface ScriptSyntax {
  readonly ok: boolean;
  readonly line?: number;
  readonly message?: string;
}

export interface ScriptDetail {
  readonly kind: "script";
  readonly lines?: number;
  readonly bytes?: number;
  readonly sha256?: string;
  readonly encoding?: string;
  readonly summary?: string;
  readonly usesFullmag?: boolean;
  readonly syntax?: ScriptSyntax;
  readonly unresolvedImports?: readonly string[];
  /** Top-level modules the static scan found (backend scan, nothing executed). */
  readonly imports?: readonly string[];
  /** False when the backend did not parse the script: syntax is then "not checked". */
  readonly syntaxChecked?: boolean;
  /** The facts come from a line scan, not from Python's parser. */
  readonly degraded?: boolean;
  /** Why Python did not (fully) check the file; present only with `degraded`. */
  readonly degradedReason?: string;
  readonly envReads?: readonly string[];
  readonly lastRun?: WorkspaceLastRun;
  readonly readError?: string;
}

export interface ResultStage {
  readonly id: string;
  readonly kind?: string;
  readonly steps?: number;
  readonly timeS?: number;
}

export interface ResultSource {
  readonly kind: string;
  readonly path: string;
  readonly sha256?: string;
}

export interface ResultDetail {
  readonly kind: "result";
  readonly format?: string;
  readonly formatVersion?: string;
  readonly runId?: string;
  readonly source?: ResultSource;
  readonly stages: readonly ResultStage[];
  readonly quantities: readonly string[];
  /** Already formatted for display; the wire shape of the grid is not fixed. */
  readonly grid?: string;
  readonly frames?: number;
  readonly totalBytes?: number;
  readonly status?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly readError?: string;
}

export type ApiItemDetail = ProjectDetail | ScriptDetail | ResultDetail;

export interface ApiWorkspaceEvent {
  /** Unique within one answer, for React; derived, not sent. */
  readonly key: string;
  readonly at: string;
  readonly kind: string;
  readonly actor: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface ApiItemDetailAnswer {
  readonly item: ApiWorkspaceItem;
  /** Absent when the backend could not read the item's file; the item still shows. */
  readonly detail?: ApiItemDetail;
  readonly events: readonly ApiWorkspaceEvent[];
  readonly readAt?: string;
  readonly linkedResults: readonly ApiWorkspaceItem[];
  readonly linkedSource?: ApiWorkspaceItem;
}

/* ── Roots and scan ─────────────────────────────────────────────────────── */

export interface ApiWorkspaceRoot {
  readonly path: string;
  readonly kinds: readonly ApiItemKind[];
  readonly recursive: boolean;
  readonly enabled: boolean;
}

export interface ApiScanReport {
  readonly scanned: number;
  readonly added: number;
  readonly updated: number;
  readonly missing: number;
  readonly skipped: number;
  readonly warnings: readonly string[];
}

/* ── Parsing helpers ────────────────────────────────────────────────────── */

type Raw = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Raw =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const bool = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;
const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry !== "")
    : undefined;

const invalid = (what: string): WorkspaceHostError =>
  new WorkspaceHostError("invalid_response", `The backend returned an unexpected ${what}.`);

const KINDS: readonly ApiItemKind[] = ["project", "script", "result"];
const STATUSES: readonly WorkspaceItemStatus[] = ["ready", "missing", "failed", "migrate", "readonly"];
const OUTCOMES: readonly WorkspaceOutcomeState[] = [
  "ready",
  "created",
  "migrated",
  "quarantined",
  "read_only_newer_schema",
];

/** The item, or null when it lacks the identity a row cannot do without. */
export function parseApiWorkspaceItem(value: unknown): ApiWorkspaceItem | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" && value.id !== "" ? value.id : undefined;
  const kind = KINDS.find((k) => k === value.kind);
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
    status: STATUSES.find((s) => s === value.status) ?? "ready",
    sizeBytes: num(value.size_bytes),
    modifiedAt: str(value.modified_at),
    meta: isRecord(value.meta) ? value.meta : {},
    hasThumbnail: value.has_thumbnail === true,
    thumbnailOrigin: THUMBNAIL_ORIGINS.find((origin) => origin === value.thumbnail_origin),
  };
}

function parseOutcome(value: unknown): WorkspaceOutcome {
  if (!isRecord(value)) throw invalid("workspace outcome");
  const state = OUTCOMES.find((s) => s === value.state);
  if (!state) throw invalid("workspace outcome state");
  return { state, detail: str(value.detail) };
}

/**
 * The envelope must be right or the whole answer is rejected; a malformed or
 * duplicate item is skipped and counted, so one bad row never hides the rest.
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

function parseLastRun(value: unknown): WorkspaceLastRun | undefined {
  if (!isRecord(value) || typeof value.status !== "string") return undefined;
  return {
    status: value.status,
    at: str(value.at) ?? "",
    durationSeconds: num(value.duration_seconds),
    device: str(value.device),
  };
}

function parseProjectDetail(value: Raw): ProjectDetail {
  const summary = isRecord(value.summary) ? value.summary : undefined;
  const model = isRecord(summary?.model) ? summary.model : {};
  const execution = isRecord(summary?.execution) ? summary.execution : {};
  const outputs = isRecord(summary?.outputs) ? summary.outputs : {};
  const preview = isRecord(value.preview) ? value.preview : undefined;
  const provenance: Provenance | null = parseProvenance({
    authors: value.authors,
    citation: value.citation,
    history: value.history,
    runs: value.runs,
  });
  return {
    kind: "project",
    schemaVersion: str(value.schema_version),
    revision: num(value.revision),
    solver: str(value.solver),
    migrated: bool(value.migrated),
    canWrite: bool(value.can_write),
    mode: str(value.mode),
    warnings: strings(value.warnings) ?? [],
    summary: summary
      ? {
          model: {
            discretisation: str(model.discretisation),
            cell: str(model.cell_size) ?? str(model.cell),
            periodicity: str(model.periodicity),
            materials: strings(model.materials),
            ms: str(model.ms),
            aex: str(model.aex),
            alpha: str(model.alpha),
            interactions: strings(model.interactions),
          },
          execution: {
            integrator: str(execution.integrator),
            tolerance: str(execution.tolerance),
            excitation: str(execution.excitation),
          },
          outputs: { frames: num(outputs.frames), sizeBytes: num(outputs.size_bytes) },
        }
      : undefined,
    authors: provenance?.authors ?? [],
    citation: provenance?.citation ?? {},
    history: provenance?.history ?? [],
    runs: provenance?.runs ?? [],
    previewColouring: str(preview?.colouring),
    readError: str(value.read_error),
  };
}

function parseScriptDetail(value: Raw): ScriptDetail {
  const syntax = isRecord(value.syntax) && typeof value.syntax.ok === "boolean"
    ? { ok: value.syntax.ok, line: num(value.syntax.line), message: str(value.syntax.message) }
    : undefined;
  const imports = isRecord(value.imports) ? value.imports : undefined;
  return {
    kind: "script",
    lines: num(value.lines),
    bytes: num(value.bytes),
    sha256: str(value.sha256),
    encoding: str(value.encoding),
    summary: str(value.summary),
    usesFullmag: bool(value.uses_fullmag),
    syntax,
    // The API sends `unresolved_imports`; the CLI inspect document nests it.
    unresolvedImports: strings(value.unresolved_imports) ?? strings(imports?.unresolved),
    imports: Array.isArray(value.imports) ? strings(value.imports) : undefined,
    syntaxChecked: bool(value.syntax_checked),
    degraded: bool(value.degraded),
    degradedReason: str(value.degraded_reason),
    envReads: strings(value.env_reads),
    lastRun: parseLastRun(value.last_run),
    readError: str(value.read_error),
  };
}

/** `{nx, ny, nz}` or a ready-made string; anything else is not shown. */
export function formatGrid(value: unknown): string | undefined {
  if (typeof value === "string") return str(value);
  if (!isRecord(value)) return undefined;
  const dims = ["nx", "ny", "nz"].map((key) => num(value[key]));
  if (dims.every((d): d is number => d !== undefined)) {
    const cells = dims.join(" × ");
    const cell = ["dx", "dy", "dz"].map((key) => num(value[key]));
    return cell.every((d): d is number => d !== undefined)
      ? `${cells} cells, ${cell.map((d) => Number((d! * 1e9).toPrecision(3))).join(" × ")} nm`
      : `${cells} cells`;
  }
  return str(value.description) ?? str(value.label);
}

function parseResultDetail(value: Raw): ResultDetail {
  const source = isRecord(value.source) ? value.source : undefined;
  const stages = Array.isArray(value.stages)
    ? value.stages.flatMap((entry): ResultStage[] => {
        if (!isRecord(entry)) return [];
        const id = str(entry.id);
        return id
          ? [{ id, kind: str(entry.kind), steps: num(entry.steps), timeS: num(entry.time_s) }]
          : [];
      })
    : [];
  return {
    kind: "result",
    format: str(value.format),
    formatVersion: str(value.format_version),
    runId: str(value.run_id),
    source:
      source && str(source.path)
        ? { kind: str(source.kind) ?? "unknown", path: str(source.path) ?? "", sha256: str(source.sha256) }
        : undefined,
    stages,
    quantities: strings(value.quantities) ?? [],
    grid: formatGrid(value.grid),
    frames: num(value.frames),
    totalBytes: num(value.total_bytes),
    status: str(value.status),
    startedAt: str(value.started_at),
    finishedAt: str(value.finished_at),
    readError: str(value.read_error),
  };
}

/** The detail, or undefined when absent or of a kind this build does not know. */
export function parseApiItemDetail(value: unknown): ApiItemDetail | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.kind) {
    case "project":
      return parseProjectDetail(value);
    case "script":
      return parseScriptDetail(value);
    case "result":
      return parseResultDetail(value);
    default:
      return undefined;
  }
}

/** Event detail arrives as an object or as JSON text; anything else is empty. */
function eventDetail(raw: unknown): Raw {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(raw) ? raw : {};
}

export function parseApiEvents(raw: unknown): readonly ApiWorkspaceEvent[] {
  if (!Array.isArray(raw)) return [];
  const occurrences = new Map<string, number>();
  const events: ApiWorkspaceEvent[] = [];
  for (const value of raw) {
    if (!isRecord(value)) continue;
    const at = str(value.at);
    const kind = str(value.kind);
    if (!at || !kind) continue;
    const actor = str(value.actor) ?? "";
    const identity = `${at}|${kind}|${actor}`;
    const seen = occurrences.get(identity) ?? 0;
    occurrences.set(identity, seen + 1);
    events.push({ key: `${identity}|${seen}`, at, kind, actor, detail: eventDetail(value.detail) });
  }
  return events;
}

/** GET /v2/workspace/items/{id}/history answers `{events}`. */
export function parseApiHistory(raw: unknown): readonly ApiWorkspaceEvent[] {
  if (!isRecord(raw)) throw invalid("workspace history");
  return parseApiEvents(raw.events);
}

function parseItemList(value: unknown): ApiWorkspaceItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = parseApiWorkspaceItem(entry);
    return item ? [item] : [];
  });
}

export function parseApiItemDetailAnswer(raw: unknown): ApiItemDetailAnswer {
  if (!isRecord(raw)) throw invalid("item detail");
  const item = parseApiWorkspaceItem(raw.item);
  if (!item) throw invalid("item detail");
  return {
    item,
    detail: parseApiItemDetail(raw.detail),
    events: parseApiEvents(raw.events),
    readAt: str(raw.read_at),
    linkedResults: parseItemList(raw.linked_results),
    linkedSource: parseApiWorkspaceItem(raw.linked_source) ?? undefined,
  };
}

export function parseApiRoots(raw: unknown): readonly ApiWorkspaceRoot[] {
  if (!isRecord(raw) || !Array.isArray(raw.roots)) throw invalid("workspace roots");
  return raw.roots.flatMap((entry): ApiWorkspaceRoot[] => {
    if (!isRecord(entry)) return [];
    const path = str(entry.path);
    if (!path) return [];
    const kinds = (strings(entry.kinds) ?? []).filter((k): k is ApiItemKind =>
      KINDS.includes(k as ApiItemKind),
    );
    return [
      {
        path,
        kinds: kinds.length > 0 ? kinds : [...KINDS],
        recursive: entry.recursive !== false,
        enabled: entry.enabled !== false,
      },
    ];
  });
}

export function parseApiScanReport(raw: unknown): ApiScanReport {
  if (!isRecord(raw)) throw invalid("scan report");
  const count = (value: unknown) => Math.max(0, Math.trunc(num(value) ?? 0));
  return {
    scanned: count(raw.scanned),
    added: count(raw.added),
    updated: count(raw.updated),
    missing: count(raw.missing),
    skipped: count(raw.skipped),
    warnings: strings(raw.warnings) ?? [],
  };
}

/* ── Typed reads of `meta` ──────────────────────────────────────────────── */

export const metaString = (item: Pick<ApiWorkspaceItem, "meta">, key: string): string | undefined =>
  str(item.meta[key]);
export const metaNumber = (item: Pick<ApiWorkspaceItem, "meta">, key: string): number | undefined =>
  num(item.meta[key]);

export function metaLastRun(item: Pick<ApiWorkspaceItem, "meta">): WorkspaceLastRun | undefined {
  return parseLastRun(item.meta.last_run);
}
