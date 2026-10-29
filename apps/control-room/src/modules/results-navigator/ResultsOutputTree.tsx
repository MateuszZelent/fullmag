"use client";

import {
  useMemo,
  useRef,
  type KeyboardEvent,
  type ReactElement,
} from "react";

import type {
  ResultsCatalog,
  ResultsEntry,
} from "@/kernel/api/resultsBrowser";
import type { ResultsBrowserUiBinding } from "@/kernel/results-browser/ResultsBrowserUiController";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";

export interface ResultsOutputTreeProps {
  catalog: ResultsCatalog | null;
  status: string;
  error: unknown;
  selectedEntryId: string | null;
  onSelect: (entry: ResultsEntry) => void;
  onRefresh: () => void;
  onNextPage: () => void;
  onReturnToLive: () => void;
  isHistoricalActive: boolean;
  ui: ResultsBrowserUiBinding;
}

interface ResultsOutputTreeModel {
  childrenByParent: ReadonlyMap<string, readonly ResultsEntry[]>;
  roots: readonly ResultsEntry[];
}

interface VisibleTreeEntry {
  depth: number;
  entry: ResultsEntry;
  hasChildren: boolean;
  parentId: string | null;
}

const ENTRY_KIND_LABELS: Readonly<Record<ResultsEntry["kind"], string>> = {
  directory: "directory",
  zarr_group: "group",
  zarr_array: "array",
  file: "file",
};

function compareEntries(left: ResultsEntry, right: ResultsEntry): number {
  return (
    left.path.localeCompare(right.path, undefined, {
      numeric: true,
      sensitivity: "base",
    }) || left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
  );
}

function buildTreeModel(
  entries: readonly ResultsEntry[],
  query: string,
): ResultsOutputTreeModel {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const children = new Map<string, ResultsEntry[]>();
  const roots: ResultsEntry[] = [];

  for (const entry of entries) {
    if (entry.parent_id !== null && byId.has(entry.parent_id)) {
      const siblings = children.get(entry.parent_id) ?? [];
      siblings.push(entry);
      children.set(entry.parent_id, siblings);
    } else {
      // An orphaned entry remains visible rather than being dropped with its
      // missing parent. This also keeps ordinary files in the output tree.
      roots.push(entry);
    }
  }

  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery.length === 0) {
    return {
      childrenByParent: sortChildren(children),
      roots: roots.sort(compareEntries),
    };
  }

  const visibleIds = new Set<string>();
  for (const entry of entries) {
    if (
      entry.name.toLocaleLowerCase().includes(normalizedQuery) ||
      entry.path.toLocaleLowerCase().includes(normalizedQuery)
    ) {
      visibleIds.add(entry.id);
      let parentId = entry.parent_id;
      while (parentId !== null) {
        const parent = byId.get(parentId);
        if (!parent) break;
        visibleIds.add(parent.id);
        parentId = parent.parent_id;
      }
    }
  }

  const filteredChildren = new Map<string, ResultsEntry[]>();
  for (const [parentId, candidates] of children) {
    const visibleChildren = candidates.filter((entry) => visibleIds.has(entry.id));
    if (visibleChildren.length > 0) filteredChildren.set(parentId, visibleChildren);
  }
  return {
    childrenByParent: sortChildren(filteredChildren),
    roots: roots.filter((entry) => visibleIds.has(entry.id)).sort(compareEntries),
  };
}

function sortChildren(
  children: ReadonlyMap<string, readonly ResultsEntry[]>,
): ReadonlyMap<string, readonly ResultsEntry[]> {
  return new Map(
    [...children.entries()].map(([parentId, entries]) => [
      parentId,
      [...entries].sort(compareEntries),
    ]),
  );
}

function flattenVisibleEntries(
  model: ResultsOutputTreeModel,
  collapsedIds: ReadonlySet<string>,
): VisibleTreeEntry[] {
  const visible: VisibleTreeEntry[] = [];

  const append = (
    entries: readonly ResultsEntry[],
    depth: number,
    parentId: string | null,
  ) => {
    for (const entry of entries) {
      const children = model.childrenByParent.get(entry.id) ?? [];
      const hasChildren = children.length > 0;
      visible.push({ depth, entry, hasChildren, parentId });
      if (hasChildren && !collapsedIds.has(entry.id)) {
        append(children, depth + 1, entry.id);
      }
    }
  };

  append(model.roots, 0, null);
  return visible;
}

function entryPath(entry: ResultsEntry): string {
  return entry.path.trim() || entry.name.trim() || "Unnamed output";
}

function entryDisplayLabel(entry: ResultsEntry): string {
  const path = entryPath(entry);
  const basename = path.split(/[\\/]/).filter(Boolean).at(-1);
  return basename || entry.name.trim() || path;
}

function kindLabel(entry: ResultsEntry): string {
  return ENTRY_KIND_LABELS[entry.kind] ?? "entry";
}

function optionalShape(entry: ResultsEntry): string | null {
  const candidate = entry as ResultsEntry & { shape?: readonly number[] | null };
  if (
    !Array.isArray(candidate.shape) ||
    candidate.shape.length === 0 ||
    candidate.shape.some((value) => !Number.isInteger(value) || value < 0)
  ) {
    return null;
  }
  return candidate.shape.join(" × ");
}

function formatBytes(sizeBytes: number | null): string {
  if (sizeBytes === null || !Number.isFinite(sizeBytes) || sizeBytes < 0) return "—";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KiB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function resultStatusLabel(status: string | null | undefined): string | null {
  const normalized = status?.trim().toLocaleLowerCase();
  if (!normalized || normalized === "ready") return null;
  if (normalized === "metadata_only") return "Metadata only";
  if (normalized === "unsupported") return "Unsupported";
  if (normalized === "unreadable") return "Unreadable";
  return normalized.replaceAll("_", " ");
}

function errorMessage(error: unknown): string | null {
  if (typeof error === "string" && error.trim().length > 0) return error;
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" && message.trim().length > 0 ? message : null;
  }
  return null;
}

export function ResultsOutputTree({
  catalog,
  status,
  error,
  selectedEntryId,
  onSelect,
  onRefresh,
  onNextPage,
  onReturnToLive,
  isHistoricalActive,
  ui,
}: ResultsOutputTreeProps) {
  const treeRef = useRef<HTMLUListElement | null>(null);
  const model = useMemo(
    () => buildTreeModel(catalog?.entries ?? [], ui.query),
    [catalog?.entries, ui.query],
  );
  const visibleEntries = useMemo(
    () => flattenVisibleEntries(model, new Set(ui.collapsedIds)),
    [model, ui.collapsedIds],
  );
  const visibleEntryIds = useMemo(
    () => new Set(visibleEntries.map(({ entry }) => entry.id)),
    [visibleEntries],
  );
  const activeEntryId = visibleEntryIds.has(ui.focusedEntryId ?? "")
    ? ui.focusedEntryId
    : visibleEntryIds.has(selectedEntryId ?? "")
      ? selectedEntryId
      : (visibleEntries[0]?.entry.id ?? null);
  const catalogError = errorMessage(error);
  const isLoading = status === "loading" || status === "pending";
  const rootLabel = catalog?.root_label?.trim() || "Results output";
  const catalogStatus = resultStatusLabel(catalog?.status);
  const catalogReason = catalog?.reason?.trim() || null;
  const searchIsPartial = Boolean(catalog?.truncated || catalog?.next_cursor);

  const focusEntry = (entryId: string) => {
    ui.setFocusedEntryId(entryId);
    const element = Array.from(
      treeRef.current?.querySelectorAll<HTMLElement>("[data-entry-id]") ?? [],
    ).find((item) => item.dataset.entryId === entryId);
    element?.focus();
  };

  const handleTreeKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const target = event.target as HTMLElement;
    if (target.getAttribute("role") !== "treeitem") return;
    const currentId = target.dataset.entryId ?? null;
    const currentIndex = visibleEntries.findIndex(({ entry }) => entry.id === currentId);
    if (currentIndex < 0) return;

    const current = visibleEntries[currentIndex];
    let handled = true;
    switch (event.key) {
      case "ArrowDown": {
        const next = visibleEntries[currentIndex + 1];
        if (next) focusEntry(next.entry.id);
        break;
      }
      case "ArrowUp": {
        const previous = visibleEntries[currentIndex - 1];
        if (previous) focusEntry(previous.entry.id);
        break;
      }
      case "Home": {
        const first = visibleEntries[0];
        if (first) focusEntry(first.entry.id);
        break;
      }
      case "End": {
        const last = visibleEntries[visibleEntries.length - 1];
        if (last) focusEntry(last.entry.id);
        break;
      }
      case "ArrowLeft":
        if (current.hasChildren && !ui.collapsedIds.includes(current.entry.id)) {
          ui.setCollapsed(current.entry.id, true);
        } else if (current.parentId) {
          focusEntry(current.parentId);
        }
        break;
      case "ArrowRight":
        if (current.hasChildren) {
          if (ui.collapsedIds.includes(current.entry.id)) {
            ui.setCollapsed(current.entry.id, false);
          } else {
            const child = visibleEntries[currentIndex + 1];
            if (child?.parentId === current.entry.id) focusEntry(child.entry.id);
          }
        }
        break;
      case "Enter":
      case " ":
        onSelect(current.entry);
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const renderEntry = (
    entry: ResultsEntry,
    depth: number,
    position: number,
    setSize: number,
  ): ReactElement => {
    const children = model.childrenByParent.get(entry.id) ?? [];
    const hasChildren = children.length > 0;
    const expanded = hasChildren && !ui.collapsedIds.includes(entry.id);
    const shape = entry.kind === "zarr_array" ? optionalShape(entry) : null;
    const fullPath = entryPath(entry);
    const label = entryDisplayLabel(entry);
    const entryStatus = resultStatusLabel(entry.status);
    const entryReason = entry.reason?.trim() || null;
    const statusDescription = entryStatus || entryReason
      ? (entryStatus ?? "Ready") + (entryReason ? `: ${entryReason}` : "")
      : null;
    const metadataDescription = [
      kindLabel(entry),
      shape,
      entry.size_bytes !== null ? formatBytes(entry.size_bytes) : null,
    ].filter((value): value is string => Boolean(value)).join(" · ");
    const accessibleLabel = [label, metadataDescription, statusDescription]
      .filter((value): value is string => Boolean(value))
      .join(", ");
    const title = [fullPath, metadataDescription, statusDescription]
      .filter((value): value is string => Boolean(value))
      .join(" — ");

    return (
      <li
        key={entry.id}
        aria-expanded={hasChildren ? expanded : undefined}
        aria-level={depth + 1}
        aria-posinset={position}
        aria-selected={selectedEntryId === entry.id}
        aria-setsize={setSize}
        aria-label={accessibleLabel}
        className="min-w-0 max-w-full overflow-hidden"
        data-entry-id={entry.id}
        data-entry-status={entry.status ?? "ready"}
        role="treeitem"
        tabIndex={activeEntryId === entry.id ? 0 : -1}
        title={title}
        onFocus={(event) => {
          if (event.target === event.currentTarget) ui.setFocusedEntryId(entry.id);
        }}
      >
        <div className="flex min-w-0 max-w-full items-center gap-1">
          {hasChildren ? (
            <Button
              aria-label={`${expanded ? "Collapse" : "Expand"} ${fullPath}`}
              className="shrink-0 px-1.5"
              size="icon"
              tabIndex={-1}
              type="button"
              variant="ghost"
              onClick={(event) => {
                event.stopPropagation();
                focusEntry(entry.id);
                ui.toggleCollapsed(entry.id);
              }}
            >
              {expanded ? "▾" : "▸"}
            </Button>
          ) : (
            <span aria-hidden="true" className="w-fm-control-sm shrink-0" />
          )}
          <Button
            aria-current={selectedEntryId === entry.id ? "true" : undefined}
            aria-label={`Select ${fullPath}`}
            className="min-w-0 max-w-full flex-1 justify-start gap-2 overflow-hidden px-2 py-1.5 text-left"
            data-entry-kind={entry.kind}
            data-entry-select="true"
            size="sm"
            tabIndex={-1}
            type="button"
            variant={selectedEntryId === entry.id ? "primary" : "ghost"}
            title={title}
            onClick={(event) => {
              event.stopPropagation();
              focusEntry(entry.id);
              onSelect(entry);
            }}
          >
            <span className="min-w-0 flex-1 truncate" title={title}>{label}</span>
            <Badge className="fm-results-output__kind shrink-0" variant="secondary">{kindLabel(entry)}</Badge>
            {shape ? <Badge className="fm-results-output__shape shrink-0" variant="secondary">{shape}</Badge> : null}
            {entryStatus ? <Badge className="shrink-0" variant="secondary">{entryStatus}</Badge> : null}
            {entry.size_bytes !== null ? (
              <span className="fm-results-output__bytes shrink-0 text-fm-xs text-fm-muted">{formatBytes(entry.size_bytes)}</span>
            ) : null}
          </Button>
        </div>
        {expanded ? (
          <ul className="fm-results-output__children grid min-w-0 gap-0.5 overflow-hidden border-l border-fm-subtle" role="group">
            {children.map((child, index) =>
              renderEntry(child, depth + 1, index + 1, children.length),
            )}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <section aria-label="Saved result outputs" className="fm-results-output grid grid-cols-1 w-full min-w-0 max-w-full gap-3 overflow-x-hidden p-3">
      <header className="grid min-w-0 gap-1">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <h2 className="m-0 min-w-0 truncate text-fm-md font-semibold text-fm-primary">{rootLabel}</h2>
          <div className="flex shrink-0 gap-1">
            <Button aria-label="Refresh results output" size="icon" type="button" variant="ghost" onClick={onRefresh}>↻</Button>
            {isHistoricalActive ? (
              <Button size="sm" type="button" variant="secondary" onClick={onReturnToLive}>Return to live</Button>
            ) : null}
          </div>
        </div>
        <p className="m-0 min-w-0 truncate text-fm-xs text-fm-muted" title={catalog?.run_id ?? undefined}>
          Run: {catalog?.run_id ?? "—"} · Revision: {catalog?.revision ?? "—"}
        </p>
        {catalogStatus || catalogReason ? (
          <p className="m-0 min-w-0 break-words text-fm-xs text-fm-muted" role="status">
            Catalog: {catalogStatus ?? "ready"}{catalogReason ? " · " + catalogReason : ""}
          </p>
        ) : null}
      </header>

      {catalogError ? <p className="m-0 text-fm-xs text-fm-danger" role="alert">{catalogError}</p> : null}
      {isLoading && catalog === null ? <p className="m-0 text-fm-xs text-fm-muted" role="status">Loading saved outputs…</p> : null}
      {!isLoading && catalog === null && !catalogError ? (
        <p className="m-0 text-fm-xs text-fm-muted" role="status">No results catalog is available.</p>
      ) : null}

      {catalog ? (
        <>
          <label className="grid min-w-0 gap-1 text-fm-xs text-fm-muted" htmlFor="fm-results-output-search">
            Search outputs
            <Input
              id="fm-results-output-search"
              aria-label="Search saved result outputs"
              aria-describedby={searchIsPartial ? "fm-results-output-search-help" : undefined}
              placeholder="Filter by path or name"
              type="search"
              value={ui.query}
              onChange={(event) => ui.setQuery(event.currentTarget.value)}
            />
          </label>
          {searchIsPartial ? (
            <p className="m-0 min-w-0 break-words text-fm-xs text-fm-muted" id="fm-results-output-search-help" role="status">
              Filter searches loaded entries only; load more pages to search the full catalog.
            </p>
          ) : null}
          <p className="m-0 min-w-0 break-words text-fm-xs text-fm-muted" role="status">
            Revision {catalog.revision} · {catalog.entries.length} loaded of {catalog.total_count} total
            {catalog.truncated ? " · truncated" : ""}
          </p>
          {model.roots.length > 0 ? (
            <ul
              aria-label="Result output entries"
              className="m-0 grid w-full min-w-0 max-w-full gap-0.5 overflow-x-hidden list-none p-0"
              ref={treeRef}
              role="tree"
              onKeyDown={handleTreeKeyDown}
            >
              {model.roots.map((entry, index) => renderEntry(entry, 0, index + 1, model.roots.length))}
            </ul>
          ) : (
            <p className="m-0 text-fm-xs text-fm-muted" role="status">
              {ui.query.trim() ? "No outputs match this filter." : "The result catalog contains no entries."}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-fm-xs text-fm-muted">{catalog.next_cursor ? "More output pages are available." : "End of output catalog."}</span>
            <Button disabled={!catalog.next_cursor || isLoading} size="sm" type="button" variant="secondary" onClick={onNextPage}>Next page</Button>
          </div>
        </>
      ) : null}
    </section>
  );
}
