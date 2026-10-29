"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

import type {
  ResultsCatalog,
  ResultsEntry,
  ResultsSource,
} from "@/kernel/api/resultsBrowser";
import { useKernel } from "@/kernel/KernelContext";
import { useResultsCatalogResource } from "@/kernel/resources/resultsBrowserResources";
import { sessionResourceIdentityKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import {
  ResultsBrowserUiController,
  useResultsBrowserUi,
  type ResultsBrowserUiBinding,
  type ResultsBrowserUiIdentity,
} from "@/kernel/results-browser/ResultsBrowserUiController";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import { returnResultsToLive } from "@/kernel/visualization/returnResultsToLive";
import { useSnapshotVisualization } from "@/kernel/visualization/useSnapshotVisualization";
import { Button } from "@/shared/ui/Button";

import { ResultsOutputTree } from "./ResultsOutputTree";

const CURRENT_RESULTS_SOURCE: ResultsSource = Object.freeze({ kind: "current" });

interface CatalogPage {
  requestCursor: string | null;
  catalog: ResultsCatalog;
}

interface PaginationState {
  revision: string | null;
  cursor: string | null;
  pages: CatalogPage[];
}

/**
 * Legacy catalogs may not carry a run or session identity. Keep their tree
 * controls usable for this mounted browser, without putting unknown state in
 * the shared kernel store or pretending that an identity fence exists.
 */
function localResultsBrowserUiScopeKey(
  source: ResultsSource,
  runId: string | null,
  sessionIdentityKey: string | null,
): string {
  return JSON.stringify([
    source.kind,
    source.kind === "workspace" ? source.itemId : null,
    runId,
    sessionIdentityKey,
  ]);
}

class LocalResultsBrowserUiController extends ResultsBrowserUiController {
  constructor(readonly scopeKey: string) {
    super();
  }
}

function useLocalResultsBrowserUi(scopeKey: string): ResultsBrowserUiBinding {
  const controller = useMemo(
    () => new LocalResultsBrowserUiController(scopeKey),
    [scopeKey],
  );
  const localKey = "local";
  const subscribe = useCallback(
    (listener: () => void) => controller.subscribe(localKey, listener),
    [controller],
  );
  const getSnapshot = useCallback(
    () => controller.getSnapshot(localKey),
    [controller],
  );
  const state = useSyncExternalStore(
    subscribe,
    getSnapshot,
    controller.getServerSnapshot,
  );
  const setQuery = useCallback((value: string) => {
    controller.setQuery(localKey, value);
  }, [controller]);
  const toggleCollapsed = useCallback((entryId: string) => {
    controller.toggleCollapsed(localKey, entryId);
  }, [controller]);
  const setCollapsed = useCallback((entryId: string, collapsed: boolean) => {
    controller.setCollapsed(localKey, entryId, collapsed);
  }, [controller]);
  const setFocusedEntryId = useCallback((entryId: string | null) => {
    controller.setFocusedEntryId(localKey, entryId);
  }, [controller]);
  return { ...state, setQuery, toggleCollapsed, setCollapsed, setFocusedEntryId };
}

function sourceKey(source: ResultsSource): string {
  return source.kind === "current" ? "current" : "workspace:" + source.itemId;
}

function sameSource(left: ResultsSource, right: ResultsSource): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "current" && right.kind === "current"
    ? true
    : left.kind === "workspace" && right.kind === "workspace" && left.itemId === right.itemId;
}

function catalogFromPages(
  pages: readonly CatalogPage[],
  fallback: ResultsCatalog | null,
): ResultsCatalog | null {
  if (pages.length === 0) return fallback;
  const revision = fallback?.revision ?? pages[0]?.catalog.revision;
  const revisionPages = revision
    ? pages.filter((page) => page.catalog.revision === revision)
    : pages;
  const first = revisionPages[0]?.catalog;
  if (!first) return fallback;

  const entriesById = new Map<string, ResultsEntry>();
  for (const page of revisionPages) {
    for (const entry of page.catalog.entries) entriesById.set(entry.id, entry);
  }
  const last = revisionPages[revisionPages.length - 1]?.catalog ?? first;
  return {
    ...first,
    entries: [...entriesById.values()],
    next_cursor: last.next_cursor,
    total_count: Math.max(...revisionPages.map((page) => page.catalog.total_count)),
    truncated: revisionPages.some((page) => page.catalog.truncated),
  };
}

type ResultOutputSelectionRef = Extract<
  NonNullable<Selection["ref"]>,
  { type: "result-output" }
>;

function resultOutputSelectionEquals(
  left: ResultOutputSelectionRef | null,
  right: ResultOutputSelectionRef | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.nodeId === right.nodeId &&
    left.entry.id === right.entry.id &&
    left.revision === right.revision &&
    left.runId === right.runId &&
    sameSource(left.source, right.source);
}

function selectResultOutputRef(
  selection: Selection,
): ResultOutputSelectionRef | null {
  return selection.ref?.type === "result-output" ? selection.ref : null;
}

export type SelectedOutputStatusKind =
  | "none"
  | "current"
  | "stale-revision"
  | "stale-run"
  | "removed";

export interface SelectedOutputStatus {
  kind: SelectedOutputStatusKind;
  matchingEntry: ResultsEntry | null;
  catalogIncomplete: boolean;
}

export function selectedOutputStatus(
  selectedRef: ResultOutputSelectionRef | null,
  source: ResultsSource,
  catalog: ResultsCatalog | null,
): SelectedOutputStatus {
  if (!selectedRef || !catalog || !sameSource(selectedRef.source, source)) {
    return { kind: "none", matchingEntry: null, catalogIncomplete: false };
  }
  if (selectedRef.runId !== catalog.run_id) {
    return { kind: "stale-run", matchingEntry: null, catalogIncomplete: false };
  }
  if (selectedRef.revision === catalog.revision) {
    return { kind: "current", matchingEntry: null, catalogIncomplete: false };
  }

  const matchingEntry = catalog.entries.find((entry) => entry.id === selectedRef.entry.id) ?? null;
  const catalogIncomplete = Boolean(catalog.next_cursor || catalog.truncated);
  return {
    kind: matchingEntry || catalogIncomplete ? "stale-revision" : "removed",
    matchingEntry,
    catalogIncomplete,
  };
}

export interface ResultsOutputExplorerProps {
  source: ResultsSource;
  watch?: boolean;
}

/**
 * Resource-backed output-folder browser. It owns pagination and selection;
 * metadata, sample decoding, and rendering remain in their consumers.
 */
export function ResultsOutputExplorer({
  source,
  watch = false,
}: ResultsOutputExplorerProps) {
  const itemId = source.kind === "workspace" ? source.itemId : null;
  const stableSource = useMemo<ResultsSource>(
    () =>
      source.kind === "workspace" && itemId
        ? { kind: "workspace", itemId }
        : CURRENT_RESULTS_SOURCE,
    [itemId, source.kind],
  );
  const stableSourceKey = sourceKey(stableSource);
  return (
    <ResultsOutputExplorerHost
      key={stableSourceKey}
      source={stableSource}
      watch={watch}
    />
  );
}

function ResultsOutputExplorerHost({
  source,
  watch,
}: ResultsOutputExplorerProps) {
  const firstPage = useResultsCatalogResource(source, null, true, watch);
  return (
    <ResultsOutputExplorerPager
      firstPage={firstPage}
      source={source}
      watch={watch}
    />
  );
}

function ResultsOutputExplorerPager({
  firstPage,
  source,
  watch,
}: ResultsOutputExplorerProps & {
  firstPage: ReturnType<typeof useResultsCatalogResource>;
}) {
  const kernel = useKernel();
  const stableSourceKey = sourceKey(source);
  const selectedRef = useSelectionSelector(selectResultOutputRef, {
    isEqual: resultOutputSelectionEquals,
  });
  const snapshotState = useSnapshotVisualization();
  const [pagination, setPagination] = useState<PaginationState>({
    revision: null,
    cursor: null,
    pages: [],
  });
  const firstPageRevision = firstPage.data?.revision ?? "pending";
  const paginationMatchesFirstPage = pagination.revision === firstPageRevision;
  const cursor = paginationMatchesFirstPage ? pagination.cursor : null;
  const pages = useMemo(
    () => paginationMatchesFirstPage ? pagination.pages : [],
    [pagination.pages, paginationMatchesFirstPage],
  );
  const page = useResultsCatalogResource(
    source,
    cursor,
    cursor !== null,
    false,
  );
  const currentPage = cursor === null
    ? firstPage.data
    : page.data?.revision === firstPageRevision
      ? page.data
      : null;
  const resource = cursor === null ? firstPage : page;

  const catalog = useMemo(
    () => catalogFromPages(
      currentPage
        ? [...pages, { requestCursor: cursor, catalog: currentPage }]
        : pages,
      currentPage,
    ),
    [currentPage, cursor, pages],
  );
  const catalogError = resource.refreshError ?? resource.error;
  const awaitingPublication = source.kind === "current" && catalog === null &&
    catalogError instanceof Error &&
    "status" in catalogError && catalogError.status === 409 &&
    "code" in catalogError && catalogError.code === "current_results_not_published";
  const publicationNotice = awaitingPublication
    ? "Waiting for results publication. Saved outputs are not available yet. " +
      (watch
        ? "This panel checks for published results while it is visible."
        : "Use Refresh to check for published results.")
    : null;
  const sessionIdentity = useSessionResourceIdentity();
  const sessionIdentityKey = sessionIdentity
    ? sessionResourceIdentityKey(sessionIdentity)
    : null;
  const browserUiIdentity: ResultsBrowserUiIdentity | null = catalog?.run_id && sessionIdentityKey
    ? { source, runId: catalog.run_id, sessionIdentityKey }
    : null;
  const browserUi = useResultsBrowserUi(browserUiIdentity);
  const localBrowserUi = useLocalResultsBrowserUi(
    localResultsBrowserUiScopeKey(source, catalog?.run_id ?? null, sessionIdentityKey),
  );
  const outputBrowserUi = browserUiIdentity ? browserUi : localBrowserUi;
  const selectionStatus = selectedOutputStatus(selectedRef, source, catalog);
  const selectedEntryId = selectedRef &&
    sameSource(selectedRef.source, source) &&
    selectedRef.runId === catalog?.run_id
    ? selectedRef.entry.id
    : null;
  const isHistoricalActive = source.kind === "workspace" ||
    snapshotState.activeKey !== null;

  const selectEntry = useCallback(
    (entry: ResultsEntry) => {
      const revision = catalog?.revision;
      if (!revision) return;
      const nodeId =
        "results:output:" + stableSourceKey + ":" + encodeURIComponent(entry.id);
      kernel.selection.set(
        {
          kind: "results.output.entry",
          label: entry.path || entry.name,
          nodeId,
          objectId: null,
          ref: {
            type: "result-output",
            kind: "results.output.entry",
            nodeId,
            source,
            entry,
            revision,
            runId: catalog.run_id,
          },
        },
        "results-navigator",
      );
    },
    [catalog, kernel.selection, source, stableSourceKey],
  );

  const refresh = () => {
    setPagination({
      revision: firstPageRevision,
      cursor: null,
      pages: [],
    });
    firstPage.refetch();
  };
  const nextPage = () => {
    if (
      (cursor !== null &&
        (page.status !== "ready" || page.data?.revision !== firstPageRevision)) ||
      !catalog?.next_cursor
    ) return;
    const requestCursor = cursor;
    const nextCursor = catalog.next_cursor;
    setPagination((current) => {
      const nextPages = (current.revision === firstPageRevision ? current.pages : []).filter(
        (entry) => entry.requestCursor !== requestCursor,
      );
      if (currentPage) {
        nextPages.push({ requestCursor, catalog: currentPage });
      }
      return { revision: firstPageRevision, cursor: nextCursor, pages: nextPages };
    });
  };
  const updateSelectedOutput = useCallback(() => {
    if (
      !selectedRef ||
      selectionStatus.kind !== "stale-revision" ||
      !catalog
    ) return;
    const entry = selectionStatus.matchingEntry ?? selectedRef.entry;
    kernel.selection.set(
      {
        kind: selectedRef.kind,
        label: entry.path || entry.name,
        nodeId: selectedRef.nodeId,
        objectId: null,
        ref: {
          ...selectedRef,
          entry,
          revision: catalog.revision,
        },
      },
      "results-navigator",
    );
  }, [catalog, kernel.selection, selectedRef, selectionStatus]);
  const clearSelectedOutput = useCallback(() => {
    kernel.selection.clear("results-navigator");
  }, [kernel.selection]);
  const returnToLive = useCallback(() => returnResultsToLive(kernel), [kernel]);

  return (
    <div className="grid min-w-0 max-w-full gap-2 overflow-x-hidden">
      {selectionStatus.kind === "stale-revision" ? (
        <div className="grid min-w-0 gap-1 px-3" role="status">
          <p className="m-0 text-fm-xs text-fm-muted">
            Selected output is pinned to revision {selectedRef?.revision}; the catalog is now {catalog?.revision}.
            {selectionStatus.catalogIncomplete
              ? " The selected entry may be on a page that has not been loaded yet."
              : ""}
          </p>
          <Button
            size="sm"
            type="button"
            variant="secondary"
            onClick={updateSelectedOutput}
          >
            Update selected output
          </Button>
        </div>
      ) : null}
      {selectionStatus.kind === "stale-run" ? (
        <div className="grid min-w-0 gap-1 px-3" role="status">
          <p className="m-0 text-fm-xs text-fm-muted">
            Selected output belongs to run {selectedRef?.runId ?? "—"}, while the current catalog is run {catalog?.run_id ?? "—"}. It was not rebound by path.
          </p>
          <Button
            size="sm"
            type="button"
            variant="secondary"
            onClick={clearSelectedOutput}
          >
            Clear selected output
          </Button>
        </div>
      ) : null}
      {selectionStatus.kind === "removed" ? (
        <div className="grid min-w-0 gap-1 px-3" role="status">
          <p className="m-0 text-fm-xs text-fm-muted">
            Selected output is not present in the complete catalog at revision {catalog?.revision}.
          </p>
          <Button
            size="sm"
            type="button"
            variant="secondary"
            onClick={clearSelectedOutput}
          >
            Clear selected output
          </Button>
        </div>
      ) : null}
      <ResultsOutputTree
        catalog={catalog}
        error={awaitingPublication ? null : catalogError}
        publicationNotice={publicationNotice}
        isHistoricalActive={isHistoricalActive}
        returnActionLabel={sessionIdentity ? "Return to live" : "Close results"}
        onNextPage={nextPage}
        onRefresh={refresh}
        onReturnToLive={returnToLive}
        onSelect={selectEntry}
        selectedEntryId={selectedEntryId}
        status={resource.status}
        ui={outputBrowserUi}
      />
    </div>
  );
}

export default ResultsOutputExplorer;
