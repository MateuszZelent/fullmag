"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { FileCode2, FilePlus2, FolderOpen, LayoutGrid, List, RefreshCw, Search } from "lucide-react";
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

import {
  SORT_LABELS,
  buildRows,
  coerceSort,
  projectRowKey,
  resultRowKey,
  scriptRowKey,
  sortKeysFor,
  type KindFilter,
  type RecentRow,
  type SortKey,
} from "../model/recentRows";
import { startScreenStore, type SelectionActionKind } from "../model/startScreenState";
import { startSettings } from "../model/startSettings";
import type { RecentEntry, RecentFilter } from "../model/types";
import type { RecentIndexController } from "../model/useRecentIndex";
import type { WorkspaceItemId } from "../model/workspaceItems";
import {
  addPathOutcome,
  type WorkspaceResultsView,
  type WorkspaceScriptsView,
} from "../model/workspaceSource";
import { SectionHeader } from "../ui/SectionHeader";

import { ProjectCard } from "./ProjectCard";
import { ProjectRow, rowDomId } from "./ProjectRow";
import { VIRTUALISE_ABOVE, buildListItems, type RecentListItem } from "./recentListModel";
import { ResultRow, resultRowDomId } from "./ResultRow";
import { ScriptRow, scriptRowDomId } from "./ScriptRow";

const HEADER_HEIGHT = 26;
const ROW_HEIGHT = 52;

const KINDS = [
  { label: "All", value: "all" },
  { label: "Projects", value: "project" },
  { label: "Scripts", value: "script" },
] as const satisfies readonly { label: string; value: KindFilter }[];

/** Result folders only exist where the HTTP workspace API serves them. */
const KINDS_WITH_RESULTS = [
  ...KINDS,
  { label: "Results", value: "result" },
] as const satisfies readonly { label: string; value: KindFilter }[];

const SOLVER_FILTERS = [
  { label: "All", value: "all" },
  { label: "FDM", value: "fdm" },
  { label: "FEM", value: "fem" },
  { label: "Pinned", value: "pinned" },
] as const satisfies readonly { label: string; value: RecentFilter }[];

/** Scripts and result folders have no solver, so their lists offer only the filters that apply. */
const SCRIPT_FILTERS = [
  { label: "All", value: "all" },
  { label: "Pinned", value: "pinned" },
] as const satisfies readonly { label: string; value: RecentFilter }[];

const NOUN: Readonly<Record<KindFilter, { title: string; plural: string }>> = {
  all: { title: "Recent work", plural: "items" },
  project: { title: "Recent projects", plural: "projects" },
  script: { title: "Recent scripts", plural: "scripts" },
  result: { title: "Result folders", plural: "result folders" },
};

const PLACEHOLDER: Readonly<Record<KindFilter, string>> = {
  all: "Filter by name, path or tag",
  project: "Filter by name, path or tag",
  script: "Filter by name or path",
  result: "Filter by name or path",
};

/** Neither a backend serving the workspace database nor a desktop host answered. */
export const UNAVAILABLE_NOTE =
  "The recent-project index needs the desktop app or a Fullmag backend that serves the workspace database.";

const SCRIPT_RUN_NOTE = "Use Run in new window in the details panel to run it.";
const RESULT_OPEN_NOTE =
  "A result folder has no viewer of its own yet. Open its source project from the details panel; the saved runs are listed under Results.";

type Notice = { readonly tone: "warning" | "info"; readonly text: string };

const domIdOf = (row: RecentRow): string =>
  row.kind === "project"
    ? rowDomId(row.entry.projectId)
    : row.kind === "script"
      ? scriptRowDomId(row.item.id)
      : resultRowDomId(row.item.id);

function selectRow(row: RecentRow): void {
  if (row.kind === "project") startScreenStore.setSelectedProject(row.entry.projectId);
  else if (row.kind === "script") startScreenStore.setSelectedScript(row.item.id);
  else startScreenStore.setSelectedResult(row.item.id);
}

export interface RecentProjectsProps {
  readonly recent: RecentIndexController;
  readonly scripts: WorkspaceScriptsView;
  readonly results: WorkspaceResultsView;
  /**
   * Adds one existing absolute path to the workspace database (the browser has
   * no file picker). Null when no backend serves the database; the button is
   * then not offered. Resolves to a failure message, or null on success.
   */
  readonly onAddPath: ((path: string) => Promise<string | null>) | null;
  readonly browseDisabledReason: string | null;
  readonly onBrowse: () => void;
  /** Runs the native script picker (the same flow as the palette command). */
  readonly onOpenScript: () => void;
  /** Whether a desktop shell is present, so the picker can run. */
  readonly canOpenScript: boolean;
  /** A failure of the open-script flow, shown with the list's other notices. */
  readonly scriptFlowNotice?: string | null;
  /** Resolves to the reason the project did not open, or null on success. */
  readonly onOpen: (entry: RecentEntry) => Promise<string | null>;
  readonly searchRef?: Ref<HTMLInputElement>;
}

export function RecentProjects({
  recent,
  scripts,
  results,
  onAddPath,
  browseDisabledReason,
  onBrowse,
  onOpenScript,
  canOpenScript,
  scriptFlowNotice = null,
  onOpen,
  searchRef,
}: RecentProjectsProps) {
  const {
    searchFocusNonce,
    focusListNonce,
    rebuildNonce,
    selectedProjectId,
    selectedScriptId,
    selectedResultId,
    selectionAction,
  } = useSyncExternalStore(
    startScreenStore.subscribe,
    startScreenStore.getSnapshot,
    startScreenStore.getServerSnapshot,
  );

  // The kind and the sort are remembered across sessions; the solver filter
  // and the search text are per visit, as before.
  const settings = useSyncExternalStore(
    startSettings.subscribe,
    startSettings.getSnapshot,
    startSettings.getServerSnapshot,
  );
  const state = recent.state;
  const scriptsState = scripts.state;
  // Without a desktop host (or one that predates the database) there are no
  // scripts to switch to: the list is the project list, as it always was.
  const scriptsUnavailable = scriptsState.kind === "unavailable";
  const resultsState = results.state;
  const resultsOffered = resultsState.kind !== "unavailable";
  const kind: KindFilter = scriptsUnavailable
    ? "project"
    : settings.recentKind === "result" && !resultsOffered
      ? "all"
      : settings.recentKind;
  const sort: SortKey = coerceSort(kind, settings.recentSort);
  const [filter, setFilter] = useState<RecentFilter>("all");
  const effectiveFilter: RecentFilter =
    (kind === "script" || kind === "result") && (filter === "fdm" || filter === "fem")
      ? "all"
      : filter;
  // The settings default applies until the user picks a view in this session.
  const [chosenView, setView] = useState<"list" | "grid" | null>(null);
  // Cards need a project's thumbnail; scripts have none, so the grid is for
  // the Projects kind only.
  const view = kind === "project" ? (chosenView ?? settings.defaultView) : "list";
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addPath, setAddPath] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

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

  const needProjects = kind === "all" || kind === "project";
  const needScripts = kind === "all" || kind === "script";
  const needResults = (kind === "all" || kind === "result") && resultsOffered;
  const entries = useMemo(
    () => (state.kind === "ready" ? state.index.entries : []),
    [state],
  );
  const scriptItems = useMemo(
    () => (scriptsState.kind === "ready" ? scriptsState.items : []),
    [scriptsState],
  );
  const resultItems = useMemo(
    () => (resultsState.kind === "ready" ? resultsState.items : []),
    [resultsState],
  );
  const rows = useMemo(
    () =>
      buildRows({
        kind,
        entries,
        scripts: scriptItems,
        results: resultItems,
        filter: effectiveFilter,
        query,
        sort,
      }),
    [kind, entries, scriptItems, resultItems, effectiveFilter, query, sort],
  );
  const items = useMemo(() => buildListItems(rows, sort === "last_used"), [rows, sort]);
  const selectable = useMemo(
    () => items.flatMap((item) => (item.kind === "row" ? [item.row] : [])),
    [items],
  );
  // Cards wrap into a grid whose rows the virtualiser cannot size; their images
  // load lazily and are pinned in a bounded cache instead.
  const virtualised = view === "list" && selectable.length > VIRTUALISE_ABOVE;

  const selectedKey =
    selectedScriptId !== null
      ? scriptRowKey(selectedScriptId)
      : selectedResultId !== null
        ? resultRowKey(selectedResultId)
        : selectedProjectId !== null
          ? projectRowKey(selectedProjectId)
          : null;
  // The selection survives a rebuild only if its item does; otherwise fall
  // back to nothing selected rather than pointing at a row that is gone.
  const activeIndex = selectable.findIndex((row) => row.key === selectedKey);

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    estimateSize: (index) => (items[index]?.kind === "header" ? HEADER_HEIGHT : ROW_HEIGHT),
    getScrollElement: () => listRef.current,
    overscan: 8,
  });

  const select = useCallback(
    (index: number) => {
      const row = selectable[index];
      if (!row) return;
      selectRow(row);
      if (virtualised) {
        const itemIndex = items.findIndex((item) => item.kind === "row" && item.row.key === row.key);
        if (itemIndex >= 0) virtualizer.scrollToIndex(itemIndex);
      } else {
        document.getElementById(domIdOf(row))?.scrollIntoView({ block: "nearest" });
      }
    },
    [items, selectable, virtualised, virtualizer],
  );

  const activateProject = useCallback(
    async (projectId: string) => {
      const row = selectable.find((r) => r.kind === "project" && r.entry.projectId === projectId);
      if (!row || row.kind !== "project") return;
      setNotice(null);
      const failure = await onOpen(row.entry);
      setNotice(failure ? { tone: "warning", text: failure } : null);
    },
    [onOpen, selectable],
  );

  const activateScript = useCallback(
    async (id: WorkspaceItemId) => {
      const row = selectable.find((r) => r.kind === "script" && r.item.id === id);
      if (!row || row.kind !== "script") return;
      setNotice(null);
      if (row.item.status === "missing") {
        setNotice({
          tone: "warning",
          text: `${row.item.name} is no longer at ${row.item.path}. Remove it from the list or move it back.`,
        });
        return;
      }
      const failure = await scripts.open(id);
      setNotice(
        failure
          ? { tone: "warning", text: failure }
          : { tone: "info", text: `Recorded ${row.item.name} as opened. ${SCRIPT_RUN_NOTE}` },
      );
    },
    [scripts, selectable],
  );

  const activateResult = useCallback(
    (id: string) => {
      const row = selectable.find((r) => r.kind === "result" && r.item.id === id);
      if (!row || row.kind !== "result") return;
      startScreenStore.setSelectedResult(id);
      setNotice(
        row.item.status === "missing"
          ? {
              tone: "warning",
              text: `${row.item.name} is no longer at ${row.item.path}. Remove it from the list or move it back.`,
            }
          : { tone: "info", text: RESULT_OPEN_NOTE },
      );
    },
    [selectable],
  );

  const submitAddPath = useCallback(async () => {
    if (!onAddPath) return;
    setAddBusy(true);
    setAddError(null);
    const failure = await addPathOutcome(addPath, onAddPath);
    setAddBusy(false);
    if (failure) {
      setAddError(failure);
      return;
    }
    setAddPath("");
    setAddOpen(false);
  }, [addPath, onAddPath]);

  const pinResult = useCallback(
    async (id: string, pinned: boolean) => {
      const failure = await results.pin(id, pinned);
      if (failure) setNotice({ tone: "warning", text: failure });
    },
    [results],
  );

  const pinScript = useCallback(
    async (id: WorkspaceItemId, pinned: boolean) => {
      if (scripts.readOnly) {
        setNotice({ tone: "warning", text: "The workspace database is read-only; pins cannot be saved." });
        return;
      }
      const failure = await scripts.pin(id, pinned);
      if (failure) setNotice({ tone: "warning", text: failure });
    },
    [scripts],
  );

  useEffect(() => {
    if (searchFocusNonce > 0) inputRef.current?.focus();
  }, [searchFocusNonce]);

  // Open recent (quick switch): land on the list with an item selected, so
  // Enter opens and the arrows move.
  const handledListFocus = useRef(focusListNonce);
  useEffect(() => {
    if (focusListNonce === handledListFocus.current) return;
    handledListFocus.current = focusListNonce;
    listRef.current?.focus();
    const first = selectable[0];
    if (selectedKey === null && first) selectRow(first);
    // Reads the selection as it is when the request arrives, not on every change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusListNonce]);

  // A script chosen through the picker may be hidden by this visit's search or
  // filter; show it instead of selecting something the list does not display.
  useEffect(() => {
    if (selectedScriptId === null) return;
    const hidden = !selectable.some((row) => row.key === scriptRowKey(selectedScriptId));
    if (hidden && scriptItems.some((item) => item.id === selectedScriptId)) {
      setQuery("");
      setFilter("all");
    }
    // Reacts to a new selection only; the list itself changing is not a reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedScriptId]);

  // The same for a result folder selected from elsewhere (a source link).
  useEffect(() => {
    if (selectedResultId === null) return;
    const hidden = !selectable.some((row) => row.key === resultRowKey(selectedResultId));
    if (hidden && resultItems.some((item) => item.id === selectedResultId)) {
      setQuery("");
      setFilter("all");
    }
    // Reacts to a new selection only; the list itself changing is not a reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedResultId]);

  const rebuild = recent.rebuild;
  useEffect(() => {
    if (rebuildNonce > 0) void rebuild();
  }, [rebuildNonce, rebuild]);

  const forgetProject = recent.forget;

  /** Shared by the keyboard shortcuts and the palette commands. */
  const runSelectionAction = (action: SelectionActionKind) => {
    const row = selectable[activeIndex];
    if (!row) return;
    if (action === "open") {
      if (row.kind === "project") void activateProject(row.entry.projectId);
      else if (row.kind === "script") void activateScript(row.item.id);
      else activateResult(row.item.id);
    } else if (action === "pin") {
      if (row.kind === "project") void recent.pin(row.entry.projectId, !row.entry.pinned);
      else if (row.kind === "script") void pinScript(row.item.id, !row.item.pinned);
      else void pinResult(row.item.id, !row.item.pinned);
    } else {
      if (row.kind === "script" && scripts.readOnly) {
        setNotice({
          tone: "warning",
          text: "The workspace database is read-only; the script stays listed.",
        });
        return;
      }
      if (row.kind === "project") void forgetProject(row.entry.projectId);
      else if (row.kind === "script") void scripts.forget(row.item.id);
      else void results.forget(row.item.id);
      // Focus moves to the next row, or the previous one if this was last.
      const next = selectable[activeIndex + 1] ?? selectable[activeIndex - 1];
      if (next) selectRow(next);
      else {
        startScreenStore.setSelectedProject(null);
        startScreenStore.setSelectedScript(null);
        startScreenStore.setSelectedResult(null);
      }
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

  const noun = NOUN[kind];
  const hasFilters = effectiveFilter !== "all" || query.trim() !== "";
  const activeRow = activeIndex >= 0 ? selectable[activeIndex] : undefined;
  const activeDescendant = activeRow ? domIdOf(activeRow) : undefined;

  // Controls show once any source has answered; the kind switch must stay
  // reachable when one source is empty and the other is not.
  const showControls =
    state.kind === "ready" || scriptsState.kind === "ready" || resultsState.kind === "ready";
  const loading =
    kind === "result"
      ? resultsState.kind === "loading"
      : kind === "script"
        ? scriptsState.kind === "loading"
        : needProjects && state.kind === "loading";
  const projectsAnswered = needProjects && (state.kind === "ready" || state.kind === "empty");
  const scriptsAnswered = needScripts && scriptsState.kind === "ready";
  const resultsAnswered = needResults && resultsState.kind === "ready";
  const showEmpty =
    !loading && rows.length === 0 && (projectsAnswered || scriptsAnswered || resultsAnswered);
  const total =
    (needProjects ? entries.length : 0) +
    (needScripts ? scriptItems.length : 0) +
    (needResults ? resultItems.length : 0);
  const outcome = scriptsState.kind === "ready" && needScripts ? scriptsState.outcome : null;
  const shownNotice: Notice | null =
    notice ?? (scriptFlowNotice ? { tone: "warning", text: scriptFlowNotice } : null);

  const footNote = (() => {
    if (browseDisabledReason !== null) return browseDisabledReason;
    if (kind === "project" && state.kind === "unavailable") {
      return UNAVAILABLE_NOTE;
    }
    if (showControls && (projectsAnswered || scriptsAnswered || resultsAnswered)) {
      return `${selectable.length} of ${total} ${noun.plural}`;
    }
    return "";
  })();

  const renderItem = (item: RecentListItem) => {
    if (item.kind === "header") {
      return (
        <div className="fm-start-group" key={`group-${item.id}`} role="presentation">
          {item.label}
          <span className="fm-start-group__count">{item.count}</span>
        </div>
      );
    }
    const { row } = item;
    const position = { index: item.ordinal, count: selectable.length };
    if (row.kind === "result") {
      return (
        <ResultRow
          item={row.item}
          key={row.key}
          thumbnailUrl={results.thumbnailUrl}
          onActivate={activateResult}
          onSelect={(id) => startScreenStore.setSelectedResult(id)}
          onTogglePin={(id, pinned) => void pinResult(id, pinned)}
          position={position}
          selected={row.key === selectedKey}
        />
      );
    }
    if (row.kind === "script") {
      return (
        <ScriptRow
          item={row.item}
          key={row.key}
          onActivate={(id) => void activateScript(id)}
          onSelect={(id) => startScreenStore.setSelectedScript(id)}
          onTogglePin={(id, pinned) => void pinScript(id, pinned)}
          position={position}
          selected={row.key === selectedKey}
        />
      );
    }
    if (view === "grid") {
      return (
        <ProjectCard
          entry={row.entry}
          key={row.key}
          onActivate={(projectId) => void activateProject(projectId)}
          onSelect={(projectId) => startScreenStore.setSelectedProject(projectId)}
          position={position}
          selected={row.key === selectedKey}
        />
      );
    }
    return (
      <ProjectRow
        entry={row.entry}
        key={row.key}
        onActivate={(projectId) => void activateProject(projectId)}
        onSelect={(projectId) => startScreenStore.setSelectedProject(projectId)}
        onTogglePin={(projectId, pinned) => void recent.pin(projectId, pinned)}
        position={position}
        selected={row.key === selectedKey}
      />
    );
  };

  return (
    <section aria-labelledby="fm-start-recent-title" className="fm-start-section">
      <SectionHeader
        id="fm-start-recent-title"
        title={noun.title}
        tools={
          needProjects && (state.kind === "ready" || state.kind === "error") ? (
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
        {recent.announcement} {scripts.announcement}
      </div>

      {showControls ? (
        <>
          {scriptsUnavailable ? null : (
            <div className="fm-start-recent-kinds">
              <SegmentedControl
                aria-label={resultsOffered ? "Show projects, scripts, results or all" : "Show projects, scripts or both"}
                onValueChange={(value) => startSettings.update({ recentKind: value })}
                options={resultsOffered ? KINDS_WITH_RESULTS : KINDS}
                value={kind}
              />
            </div>
          )}
          <div className="fm-start-recent-toolbar">
            <label className="fm-start-search">
              <Search aria-hidden="true" size={14} />
              <input
                aria-keyshortcuts="/"
                aria-label={`Filter ${noun.title.toLowerCase()}`}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onSearchKeyDown}
                placeholder={PLACEHOLDER[kind]}
                ref={setInput}
                type="search"
                value={query}
              />
            </label>
            <SegmentedControl
              aria-label={
                kind === "script"
                  ? "Filter scripts"
                  : kind === "result"
                    ? "Filter results"
                    : "Filter by solver"
              }
              onValueChange={setFilter}
              options={kind === "script" || kind === "result" ? SCRIPT_FILTERS : SOLVER_FILTERS}
              value={effectiveFilter}
            />
            <select
              aria-label={`Sort ${noun.title.toLowerCase()}`}
              className="fm-start-sort"
              onChange={(event) => startSettings.update({ recentSort: event.target.value as SortKey })}
              value={sort}
            >
              {sortKeysFor(kind).map((key) => (
                <option key={key} value={key}>
                  {SORT_LABELS[key]}
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
                disabled={kind !== "project"}
                onClick={() => setView("grid")}
                title={kind === "project" ? "Grid view" : "The grid shows projects only"}
                type="button"
              >
                <LayoutGrid aria-hidden="true" size={14} />
              </button>
            </div>
          </div>
        </>
      ) : null}

      {loading ? <SkeletonRows label={`Loading ${noun.title.toLowerCase()}`} /> : null}

      {needProjects && state.kind === "error" ? (
        <div className="fm-start-notice fm-start-notice--warning" role="alert">
          The recent-project index could not be read: {state.message} It is rebuilt from your
          project folders, and you can still create or open a project in the meantime.
        </div>
      ) : null}

      {needScripts && scriptsState.kind === "error" ? (
        <div className="fm-start-notice fm-start-notice--warning" role="alert">
          The script history could not be read: {scriptsState.message} Projects are not affected.
        </div>
      ) : null}

      {outcome?.state === "quarantined" ? (
        <div className="fm-start-notice fm-start-notice--warning" role="status">
          The workspace database was damaged, so Fullmag set it aside and started a new one. Script
          history and pins begin again from now.
          {outcome.detail ? ` (${outcome.detail})` : ""}
        </div>
      ) : null}

      {outcome?.state === "read_only_newer_schema" ? (
        <div className="fm-start-notice fm-start-notice--warning" role="status">
          The workspace database was written by a newer Fullmag, so it is read-only here: the list is
          shown, but pins and removals are not saved.
        </div>
      ) : null}

      {shownNotice ? (
        <div
          className={cn("fm-start-notice", shownNotice.tone === "warning" && "fm-start-notice--warning")}
          role={shownNotice.tone === "warning" ? "alert" : "status"}
        >
          {shownNotice.text}
        </div>
      ) : null}

      {showEmpty ? (
        <p className="fm-start-list-empty">
          {hasFilters ? (
            <>
              Nothing matches the current filter.{" "}
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
            </>
          ) : (
            <EmptyCopy
              canOpenScript={canOpenScript}
              kind={kind === "all" && scriptsState.kind !== "ready" ? "project" : kind}
              onOpenScript={onOpenScript}
            />
          )}
        </p>
      ) : null}

      {rows.length > 0 ? (
        <div
          aria-activedescendant={activeDescendant}
          aria-label={noun.title}
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
                    {renderItem(item)}
                  </div>
                );
              })}
            </div>
          ) : (
            items.map((item) => renderItem(item))
          )}
        </div>
      ) : null}

      {onAddPath && addOpen ? (
        <form
          className="fm-start-addpath"
          onSubmit={(event) => {
            event.preventDefault();
            void submitAddPath();
          }}
        >
          <label className="fm-start-addpath__field">
            <span>Absolute path of a project (.fms), script (.py) or result folder (.zarr)</span>
            <input
              aria-describedby={addError ? "fm-start-addpath-error" : undefined}
              aria-invalid={addError !== null}
              autoComplete="off"
              onChange={(event) => setAddPath(event.target.value)}
              spellCheck={false}
              type="text"
              value={addPath}
            />
          </label>
          <Button disabled={addBusy || addPath.trim() === ""} size="sm" type="submit" variant="primary">
            {addBusy ? "Adding…" : "Add"}
          </Button>
          <Button
            onClick={() => {
              setAddOpen(false);
              setAddError(null);
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
          {addError ? (
            <p className="fm-start-addpath__error" id="fm-start-addpath-error" role="alert">
              {addError}
            </p>
          ) : null}
        </form>
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
        {onAddPath ? (
          <Button
            aria-expanded={addOpen}
            data-action="add-by-path"
            onClick={() => setAddOpen((open) => !open)}
            size="sm"
            title="Add a project, script or result folder by its absolute path"
            type="button"
            variant="secondary"
          >
            <FilePlus2 aria-hidden="true" size={14} />
            Add file by path…
          </Button>
        ) : null}
        {canOpenScript ? (
          <Button
            data-command-id="start.open-script"
            onClick={onOpenScript}
            size="sm"
            title="Open a Python script"
            type="button"
            variant="secondary"
          >
            <FileCode2 aria-hidden="true" size={14} />
            Open script…
          </Button>
        ) : null}
        <span className="fm-start-list-foot__note">{footNote}</span>
      </div>
    </section>
  );
}

/** What an empty, unfiltered list says: what is missing and the way to add it. */
function EmptyCopy({
  canOpenScript,
  kind,
  onOpenScript,
}: {
  readonly canOpenScript: boolean;
  readonly kind: KindFilter;
  readonly onOpenScript: () => void;
}) {
  const action = canOpenScript ? (
    <button className="fm-start-link" onClick={onOpenScript} type="button">
      Open script…
    </button>
  ) : null;
  if (kind === "project") {
    return <>No projects found yet. Create a simulation above, or open an existing project archive.</>;
  }
  if (kind === "script") {
    return (
      <>
        No scripts yet. A Python script you open or run with Fullmag is listed here with when you
        last used it and how its last run went. {action}
      </>
    );
  }
  return (
    <>
      Nothing here yet. Create a simulation above, open a project archive, or open a Python script.{" "}
      {action}
    </>
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

function SkeletonRows({ label }: { readonly label: string }) {
  return (
    <div aria-busy="true" aria-label={label} className="fm-start-skeleton" role="status">
      {[0, 1, 2].map((key) => (
        <span className="fm-start-skeleton__row" key={key} />
      ))}
    </div>
  );
}
