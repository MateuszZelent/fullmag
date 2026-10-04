"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { FolderOpen, LayoutGrid, List, RefreshCw, Search } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type Ref,
} from "react";

import { Button } from "@/shared/ui/Button";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import { cn } from "@/shared/utils/className";

import { filterEntries, sortEntries } from "../model/recentIndex";
import { startScreenStore, type SelectionActionKind } from "../model/startScreenState";
import { startSettings } from "../model/startSettings";
import type { RecentEntry, RecentFilter, RecentSort } from "../model/types";
import type { RecentIndexController } from "../model/useRecentIndex";
import { SectionHeader } from "../ui/SectionHeader";

import { ProjectCard } from "./ProjectCard";
import { ProjectRow, rowDomId } from "./ProjectRow";
import { VIRTUALISE_ABOVE, buildListItems, type RecentListItem } from "./recentListModel";

const HEADER_HEIGHT = 26;
const ROW_HEIGHT = 52;

const FILTERS = [
  { label: "All", value: "all" },
  { label: "FDM", value: "fdm" },
  { label: "FEM", value: "fem" },
  { label: "Pinned", value: "pinned" },
] as const satisfies readonly { label: string; value: RecentFilter }[];

const SORTS: readonly { label: string; value: RecentSort }[] = [
  { label: "Last opened", value: "lastOpened" },
  { label: "Name", value: "name" },
  { label: "Created", value: "created" },
  { label: "Size", value: "size" },
];

export interface RecentProjectsProps {
  readonly recent: RecentIndexController;
  readonly browseDisabledReason: string | null;
  readonly onBrowse: () => void;
  /** Resolves to the reason the project did not open, or null on success. */
  readonly onOpen: (entry: RecentEntry) => Promise<string | null>;
  readonly searchRef?: Ref<HTMLInputElement>;
}

export function RecentProjects({
  recent,
  browseDisabledReason,
  onBrowse,
  onOpen,
  searchRef,
}: RecentProjectsProps) {
  const { searchFocusNonce, focusListNonce, rebuildNonce, selectedProjectId, selectionAction } = useSyncExternalStore(
    startScreenStore.subscribe,
    startScreenStore.getSnapshot,
    startScreenStore.getServerSnapshot,
  );

  const [filter, setFilter] = useState<RecentFilter>("all");
  const [sort, setSort] = useState<RecentSort>("lastOpened");
  // The settings default applies until the user picks a view in this session.
  const settings = useSyncExternalStore(
    startSettings.subscribe,
    startSettings.getSnapshot,
    startSettings.getServerSnapshot,
  );
  const [chosenView, setView] = useState<"list" | "grid" | null>(null);
  const view = chosenView ?? settings.defaultView;
  const [query, setQuery] = useState("");
  const [openError, setOpenError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const setInput = useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      if (typeof searchRef === "function") searchRef(node);
      else if (searchRef) searchRef.current = node;
    },
    [searchRef],
  );

  const entries = useMemo(
    () => (recent.state.kind === "ready" ? recent.state.index.entries : []),
    [recent.state],
  );
  const items = useMemo(
    () => buildListItems(sortEntries(filterEntries(entries, filter, query), sort), sort === "lastOpened"),
    [entries, filter, query, sort],
  );
  const selectable = useMemo(
    () => items.flatMap((item) => (item.kind === "entry" ? [item.entry] : [])),
    [items],
  );
  // Cards wrap into a grid whose rows the virtualiser cannot size; their images
  // load lazily and are pinned in a bounded cache instead.
  const virtualised = view === "list" && selectable.length > VIRTUALISE_ABOVE;

  // The selection survives a rebuild only if its project does; otherwise fall
  // back to nothing selected rather than pointing at a row that is gone.
  const activeIndex = selectable.findIndex((entry) => entry.projectId === selectedProjectId);

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    estimateSize: (index) => (items[index]?.kind === "header" ? HEADER_HEIGHT : ROW_HEIGHT),
    getScrollElement: () => listRef.current,
    overscan: 8,
  });

  const select = useCallback(
    (index: number) => {
      const entry = selectable[index];
      if (!entry) return;
      startScreenStore.setSelectedProject(entry.projectId);
      if (virtualised) {
        const itemIndex = items.findIndex(
          (item) => item.kind === "entry" && item.entry.projectId === entry.projectId,
        );
        if (itemIndex >= 0) virtualizer.scrollToIndex(itemIndex);
      } else {
        document.getElementById(rowDomId(entry.projectId))?.scrollIntoView({ block: "nearest" });
      }
    },
    [items, selectable, virtualised, virtualizer],
  );

  const activate = useCallback(
    async (projectId: string) => {
      const entry = selectable.find((e) => e.projectId === projectId);
      if (!entry) return;
      setOpenError(null);
      setOpenError(await onOpen(entry));
    },
    [onOpen, selectable],
  );

  useEffect(() => {
    if (searchFocusNonce > 0) inputRef.current?.focus();
  }, [searchFocusNonce]);

  // Open recent (quick switch): land on the list with a project selected, so
  // Enter opens and the arrows move.
  const handledListFocus = useRef(focusListNonce);
  useEffect(() => {
    if (focusListNonce === handledListFocus.current) return;
    handledListFocus.current = focusListNonce;
    listRef.current?.focus();
    if (selectedProjectId === null && selectable[0]) {
      startScreenStore.setSelectedProject(selectable[0].projectId);
    }
    // Reads the selection as it is when the request arrives, not on every change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusListNonce]);

  const rebuild = recent.rebuild;
  useEffect(() => {
    if (rebuildNonce > 0) void rebuild();
  }, [rebuildNonce, rebuild]);

  const forgetSelection = recent.forget;

  /** Shared by the keyboard shortcuts and the palette commands. */
  const runSelectionAction = (kind: SelectionActionKind) => {
    const entry = selectable[activeIndex];
    if (!entry) return;
    if (kind === "open") {
      void activate(entry.projectId);
    } else if (kind === "pin") {
      void recent.pin(entry.projectId, !entry.pinned);
    } else {
      void forgetSelection(entry.projectId);
      // Focus moves to the next row, or the previous one if this was last.
      const next = selectable[activeIndex + 1] ?? selectable[activeIndex - 1];
      startScreenStore.setSelectedProject(next?.projectId ?? null);
    }
  };

  // Each palette request carries a new sequence number; handle it once. The
  // ref starts at the current number so a remount does not replay an old one.
  const handledAction = useRef(selectionAction?.seq ?? 0);
  useEffect(() => {
    if (!selectionAction || selectionAction.seq === handledAction.current) return;
    handledAction.current = selectionAction.seq;
    runSelectionAction(selectionAction.kind);
    // runSelectionAction closes over the latest selection on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionAction]);

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = activeIndex < 0 ? 0 : activeIndex;
    // In the grid, Up and Down move a whole row of cards.
    const step = () => (view === "grid" ? gridColumns(listRef.current) : 1);
    switch (event.key) {
      case "ArrowDown":
        select(Math.min(selectable.length - 1, activeIndex < 0 ? 0 : current + step()));
        break;
      case "ArrowUp":
        select(Math.max(0, current - step()));
        break;
      case "ArrowRight":
        if (view !== "grid") return;
        select(Math.min(selectable.length - 1, activeIndex < 0 ? 0 : current + 1));
        break;
      case "ArrowLeft":
        if (view !== "grid") return;
        select(Math.max(0, current - 1));
        break;
      case "Home":
        select(0);
        break;
      case "End":
        select(selectable.length - 1);
        break;
      case "PageDown":
      case "PageUp":
        select(jumpGroup(items, current, event.key === "PageDown" ? 1 : -1));
        break;
      case "Enter":
        runSelectionAction("open");
        break;
      case "Delete":
        if (activeIndex < 0) return;
        runSelectionAction("remove");
        break;
      case "p":
      case "P":
        if (!event.ctrlKey && !event.metaKey) return;
        runSelectionAction("pin");
        break;
      case "/":
        inputRef.current?.focus();
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (query) setQuery("");
      else listRef.current?.focus();
    } else if (event.key === "ArrowDown" && selectable.length > 0) {
      event.preventDefault();
      listRef.current?.focus();
      select(0);
    }
  };

  const { state } = recent;
  const hasFilters = filter !== "all" || query.trim() !== "";
  const activeDescendant =
    activeIndex >= 0 ? rowDomId(selectable[activeIndex]?.projectId ?? "") : undefined;

  return (
    <section aria-labelledby="fm-start-recent-title" className="fm-start-section">
      <SectionHeader
        id="fm-start-recent-title"
        title="Recent projects"
        tools={
          state.kind === "ready" || state.kind === "error" ? (
            <Button
              aria-busy={recent.rebuilding}
              disabled={recent.rebuilding}
              onClick={() => void recent.rebuild()}
              size="sm"
              title="Rescan the project folders"
              type="button"
              variant="ghost"
            >
              <RefreshCw aria-hidden="true" size={14} />
              {recent.rebuilding ? "Scanning…" : "Rebuild index"}
            </Button>
          ) : null
        }
      />

      <div aria-live="polite" className="fm-start-visually-hidden" role="status">
        {recent.announcement}
      </div>

      {state.kind === "ready" ? (
        <div className="fm-start-recent-toolbar">
          <label className="fm-start-search">
            <Search aria-hidden="true" size={14} />
            <input
              aria-label="Filter recent projects"
              aria-keyshortcuts="/"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Filter by name, path or tag"
              ref={setInput}
              type="search"
              value={query}
            />
          </label>
          <SegmentedControl
            aria-label="Filter by solver"
            onValueChange={setFilter}
            options={FILTERS}
            value={filter}
          />
          <select
            aria-label="Sort recent projects"
            className="fm-start-sort"
            onChange={(event) => setSort(event.target.value as RecentSort)}
            value={sort}
          >
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <div aria-label="View" className="fm-start-viewtoggle" role="group">
            <button
              aria-label="List view"
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
              title="List view"
              type="button"
            >
              <List aria-hidden="true" size={14} />
            </button>
            <button
              aria-label="Grid view"
              aria-pressed={view === "grid"}
              onClick={() => setView("grid")}
              title="Grid view"
              type="button"
            >
              <LayoutGrid aria-hidden="true" size={14} />
            </button>
          </div>
        </div>
      ) : null}

      {state.kind === "loading" ? <SkeletonRows /> : null}

      {state.kind === "error" ? (
        <div className="fm-start-notice fm-start-notice--warning" role="alert">
          The recent-project index could not be read: {state.message} It is rebuilt from your
          project folders, and you can still create or open a project in the meantime.
        </div>
      ) : null}

      {openError ? (
        <div className="fm-start-notice fm-start-notice--warning" role="alert">
          {openError}
        </div>
      ) : null}

      {state.kind === "ready" && items.length === 0 ? (
        <p className="fm-start-list-empty">
          No project matches{hasFilters ? " the current filter" : ""}.{" "}
          {hasFilters ? (
            <button
              className="fm-start-link"
              onClick={() => {
                setFilter("all");
                setQuery("");
              }}
              type="button"
            >
              Clear filters
            </button>
          ) : null}
        </p>
      ) : null}

      {state.kind === "ready" && items.length > 0 ? (
        <div
          aria-activedescendant={activeDescendant}
          aria-label="Recent projects"
          className={cn(
            "fm-start-list",
            virtualised && "fm-start-list--virtual",
            view === "grid" && "fm-start-list--grid",
          )}
          onKeyDown={onListKeyDown}
          ref={listRef}
          role="listbox"
          tabIndex={0}
        >
          {virtualised ? (
            <div className="fm-start-list__canvas" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const item = items[virtualRow.index];
                if (!item) return null;
                return (
                  <div
                    className="fm-start-list__slot"
                    key={virtualRow.key}
                    style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
                  >
                    {renderItem(item, selectable.length, selectedProjectId, recent, activate, view)}
                  </div>
                );
              })}
            </div>
          ) : (
            items.map((item) =>
              renderItem(item, selectable.length, selectedProjectId, recent, activate, view),
            )
          )}
        </div>
      ) : null}

      {state.kind === "empty" ? (
        <p className="fm-start-list-empty">
          No projects found yet. Create a simulation above, or open an existing project archive.
        </p>
      ) : null}

      <div className="fm-start-list-foot">
        <Button
          aria-keyshortcuts="Control+O"
          data-command-id="start.browse"
          disabled={browseDisabledReason !== null}
          onClick={onBrowse}
          size="sm"
          title={browseDisabledReason ?? "Open a project archive (Ctrl+O)"}
          type="button"
          variant="secondary"
        >
          <FolderOpen aria-hidden="true" size={14} />
          Browse…
        </Button>
        <span className="fm-start-list-foot__note">
          {browseDisabledReason ??
            (state.kind === "unavailable"
              ? "The recent-project index needs the desktop app."
              : state.kind === "ready"
                ? `${selectable.length} of ${entries.length} projects`
                : "")}
        </span>
      </div>
    </section>
  );
}

function renderItem(
  item: RecentListItem,
  count: number,
  selectedProjectId: string | null,
  recent: RecentIndexController,
  activate: (projectId: string) => Promise<void>,
  view: "list" | "grid",
) {
  if (item.kind === "header") {
    return (
      <div className="fm-start-group" key={`group-${item.id}`} role="presentation">
        {item.label}
        <span className="fm-start-group__count">{item.count}</span>
      </div>
    );
  }
  if (view === "grid") {
    return (
      <ProjectCard
        entry={item.entry}
        key={item.entry.projectId}
        onActivate={(projectId) => void activate(projectId)}
        onSelect={(projectId) => startScreenStore.setSelectedProject(projectId)}
        position={{ index: item.ordinal, count }}
        selected={item.entry.projectId === selectedProjectId}
      />
    );
  }
  return (
    <ProjectRow
      entry={item.entry}
      key={item.entry.projectId}
      onActivate={(projectId) => void activate(projectId)}
      onSelect={(projectId) => startScreenStore.setSelectedProject(projectId)}
      onTogglePin={(projectId, pinned) => void recent.pin(projectId, pinned)}
      position={{ index: item.ordinal, count }}
      selected={item.entry.projectId === selectedProjectId}
    />
  );
}

/** Cards per row of the rendered grid, read from the browser's own layout. */
function gridColumns(list: HTMLElement | null): number {
  if (!list) return 1;
  const tracks = getComputedStyle(list).gridTemplateColumns.split(" ").filter(Boolean);
  return Math.max(1, tracks.length);
}

/** Index of the first row of the next (or previous) date group. */
function jumpGroup(items: readonly RecentListItem[], from: number, direction: 1 | -1): number {
  const boundaries: number[] = [];
  let ordinal = 0;
  for (const item of items) {
    if (item.kind === "header") boundaries.push(ordinal);
    else ordinal += 1;
  }
  if (boundaries.length === 0) return direction === 1 ? ordinal - 1 : 0;
  if (direction === 1) return boundaries.find((b) => b > from) ?? ordinal - 1;
  return [...boundaries].reverse().find((b) => b < from) ?? 0;
}

function SkeletonRows() {
  return (
    <div aria-busy="true" aria-label="Loading recent projects" className="fm-start-skeleton" role="status">
      {[0, 1, 2].map((key) => (
        <span className="fm-start-skeleton__row" key={key} />
      ))}
    </div>
  );
}
