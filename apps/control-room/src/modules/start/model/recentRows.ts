/**
 * One list for projects and scripts: kind filter, search, sort and the
 * mapping between the two data sources, as pure functions.
 *
 * Projects come from the recent index (`RecentEntry`), scripts from the
 * workspace database (`WorkspaceItem`). Each is wrapped into a `RecentRow`
 * with the same handful of sortable fields, so "All" is a real merge by the
 * chosen key rather than two lists stacked.
 */

import { filterEntries } from "./recentIndex";
import type { RecentEntry, RecentFilter } from "./types";
import type { ApiWorkspaceItem } from "./workspaceApiTypes";
import type { WorkspaceItem, WorkspaceItemId } from "./workspaceItems";

export type KindFilter = "all" | "project" | "script" | "result";

export type SortKey = "last_used" | "name" | "modified" | "use_count" | "created" | "size";

export interface ProjectRowData {
  readonly kind: "project";
  readonly key: string;
  readonly entry: RecentEntry;
}

export interface ScriptRowData {
  readonly kind: "script";
  readonly key: string;
  readonly item: WorkspaceItem;
}

/** A result folder; only the HTTP workspace API lists them. */
export interface ResultRowData {
  readonly kind: "result";
  readonly key: string;
  readonly item: ApiWorkspaceItem;
}

export type RecentRow = ProjectRowData | ScriptRowData | ResultRowData;

export const projectRowKey = (projectId: string): string => `project:${projectId}`;
export const scriptRowKey = (id: WorkspaceItemId): string => `script:${id}`;
export const resultRowKey = (id: string): string => `result:${id}`;

export const projectRow = (entry: RecentEntry): ProjectRowData => ({
  kind: "project",
  key: projectRowKey(entry.projectId),
  entry,
});

export const scriptRow = (item: WorkspaceItem): ScriptRowData => ({
  kind: "script",
  key: scriptRowKey(item.id),
  item,
});

export const resultRow = (item: ApiWorkspaceItem): ResultRowData => ({
  kind: "result",
  key: resultRowKey(item.id),
  item,
});

/* ── Which sort options a kind offers ───────────────────────────────────── */

export const SORT_LABELS: Readonly<Record<SortKey, string>> = {
  last_used: "Last used",
  name: "Name",
  modified: "Modified",
  use_count: "Most used",
  created: "Created",
  size: "Size",
};

/**
 * Projects keep Created and Size from the earlier project list. Most used
 * needs a use count, which only the workspace database records, so it is
 * offered for scripts alone: for projects (and the merged list) the data is
 * not there, and a sort that silently ranks every project as zero is a lie.
 */
export function sortKeysFor(kind: KindFilter): readonly SortKey[] {
  switch (kind) {
    case "project":
      return ["last_used", "name", "modified", "created", "size"];
    case "script":
      return ["last_used", "name", "modified", "use_count"];
    case "result":
      return ["last_used", "name", "modified", "size"];
    case "all":
      return ["last_used", "name", "modified"];
  }
}

/** A remembered sort the active kind does not offer falls back to Last used. */
export function coerceSort(kind: KindFilter, sort: SortKey): SortKey {
  return sortKeysFor(kind).includes(sort) ? sort : "last_used";
}

export const KIND_FILTERS: readonly KindFilter[] = ["all", "project", "script", "result"];

export const isKindFilter = (value: unknown): value is KindFilter =>
  KIND_FILTERS.includes(value as KindFilter);

export const isSortKey = (value: unknown): value is SortKey =>
  typeof value === "string" && Object.hasOwn(SORT_LABELS, value);

/* ── Field mapping ──────────────────────────────────────────────────────── */

/** Milliseconds, or undefined when the field is absent or not a date. */
function parseTime(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  // A zero stamp is the "never recorded" fallback of the project index.
  return Number.isNaN(t) || t <= 0 ? undefined : t;
}

interface SortFields {
  readonly pinned: boolean;
  readonly name: string;
  readonly path: string;
  readonly lastUsed: number | undefined;
  readonly modified: number | undefined;
  readonly created: number | undefined;
  readonly size: number | undefined;
  readonly useCount: number | undefined;
  readonly kindRank: number;
  readonly id: string;
}

/**
 * The mapping, in one place:
 *
 * | key        | project              | script          |
 * |------------|----------------------|-----------------|
 * | last_used  | lastOpenedAt         | last_used_at    |
 * | modified   | modifiedAt           | modified_at     |
 * | created    | createdAt            | first_seen_at   |
 * | size       | sizeBytes            | size_bytes      |
 * | use_count  | (not recorded)       | use_count       |
 *
 * A result folder maps like a script (use_count included, it is recorded).
 */
export function sortFields(row: RecentRow): SortFields {
  if (row.kind === "project") {
    const e = row.entry;
    return {
      pinned: e.pinned === true,
      name: e.name,
      path: e.path,
      lastUsed: parseTime(e.lastOpenedAt),
      modified: parseTime(e.modifiedAt),
      created: parseTime(e.createdAt),
      size: e.sizeBytes,
      useCount: undefined,
      kindRank: 0,
      id: e.projectId,
    };
  }
  const s = row.item;
  return {
    pinned: s.pinned,
    name: s.name,
    path: s.path,
    lastUsed: parseTime(s.lastUsedAt),
    modified: parseTime(s.modifiedAt),
    created: parseTime(s.firstSeenAt),
    size: s.sizeBytes,
    useCount: s.useCount,
    kindRank: row.kind === "script" ? 1 : 2,
    id: String(s.id).padStart(12, "0"),
  };
}

// Case-insensitive, accent-sensitive, digits compared as numbers: "Run 2"
// before "run 10", "Éclair" next to "eclair" but not equal to it.
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "accent" });

/** Descending numeric compare; a missing value sorts after every present one. */
function byDescending(a: number | undefined, b: number | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return b - a;
}

function primary(a: SortFields, b: SortFields, key: SortKey): number {
  switch (key) {
    case "name":
      return NAME_COLLATOR.compare(a.name, b.name);
    case "last_used":
      return byDescending(a.lastUsed, b.lastUsed);
    case "modified":
      return byDescending(a.modified, b.modified);
    case "created":
      return byDescending(a.created, b.created);
    case "size":
      return byDescending(a.size, b.size);
    case "use_count":
      return byDescending(a.useCount, b.useCount);
  }
}

/**
 * Pinned rows first in every sort, then the chosen key. Ties fall through
 * the same chain for every key, so the order is total and stable across
 * refreshes: name (case-insensitive), path, kind (projects first), id.
 */
export function compareRows(a: RecentRow, b: RecentRow, key: SortKey): number {
  const fa = sortFields(a);
  const fb = sortFields(b);
  if (fa.pinned !== fb.pinned) return fa.pinned ? -1 : 1;
  return (
    primary(fa, fb, key) ||
    (key === "name" ? 0 : NAME_COLLATOR.compare(fa.name, fb.name)) ||
    (fa.path < fb.path ? -1 : fa.path > fb.path ? 1 : 0) ||
    fa.kindRank - fb.kindRank ||
    (fa.id < fb.id ? -1 : fa.id > fb.id ? 1 : 0)
  );
}

export function sortRows(rows: readonly RecentRow[], key: SortKey): RecentRow[] {
  return [...rows].sort((a, b) => compareRows(a, b, key));
}

/* ── Filtering ──────────────────────────────────────────────────────────── */

/**
 * Scripts have no solver, so the FDM and FEM chips exclude them; Pinned
 * applies to both. The search matches name and path, like the project box
 * (which also reads tags), case-insensitively.
 */
export function filterScripts(
  items: readonly WorkspaceItem[],
  filter: RecentFilter,
  query: string,
): WorkspaceItem[] {
  const q = query.trim().toLowerCase();
  return items.filter((s) => {
    if (filter === "fdm" || filter === "fem") return false;
    if (filter === "pinned" && !s.pinned) return false;
    return q === "" || `${s.name} ${s.path}`.toLowerCase().includes(q);
  });
}

/** Result folders have no solver either; the search reads name and path. */
export function filterResults(
  items: readonly ApiWorkspaceItem[],
  filter: RecentFilter,
  query: string,
): ApiWorkspaceItem[] {
  const q = query.trim().toLowerCase();
  return items.filter((r) => {
    if (filter === "fdm" || filter === "fem") return false;
    if (filter === "pinned" && !r.pinned) return false;
    return q === "" || `${r.name} ${r.path}`.toLowerCase().includes(q);
  });
}

export interface BuildRowsInput {
  readonly kind: KindFilter;
  readonly entries: readonly RecentEntry[];
  readonly scripts: readonly WorkspaceItem[];
  readonly results?: readonly ApiWorkspaceItem[];
  readonly filter: RecentFilter;
  readonly query: string;
  readonly sort: SortKey;
}

/** Filter, merge and sort. The sort is coerced to one the kind offers. */
export function buildRows({
  kind,
  entries,
  scripts,
  results = [],
  filter,
  query,
  sort,
}: BuildRowsInput): RecentRow[] {
  const rows: RecentRow[] = [];
  if (kind === "all" || kind === "project") {
    for (const entry of filterEntries(entries, filter, query)) rows.push(projectRow(entry));
  }
  if (kind === "all" || kind === "script") {
    for (const item of filterScripts(scripts, filter, query)) rows.push(scriptRow(item));
  }
  if (kind === "all" || kind === "result") {
    for (const item of filterResults(results, filter, query)) rows.push(resultRow(item));
  }
  return sortRows(rows, coerceSort(kind, sort));
}

/** The recency group of a row: both kinds expose their last use the same way. */
export interface RowRecency {
  readonly row: RecentRow;
  readonly pinned: boolean;
  readonly lastOpenedAt: string;
}

export function rowRecency(row: RecentRow): RowRecency {
  return row.kind === "project"
    ? { row, pinned: row.entry.pinned === true, lastOpenedAt: row.entry.lastOpenedAt }
    : { row, pinned: row.item.pinned, lastOpenedAt: row.item.lastUsedAt };
}
