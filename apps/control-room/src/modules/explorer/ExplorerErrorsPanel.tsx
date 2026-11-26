"use client";

import {
  AlertOctagon,
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Search,
  Trash2,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import {
  buildSessionErrorFingerprint,
  formatSessionErrorsForAiReport,
  formatSingleSessionErrorForAi,
  mergeErrorLists,
  sessionErrorCategoryLabel,
  sessionErrorStore,
  useSessionErrors,
  type SessionErrorCategory,
  type SessionErrorEntry,
  type SessionErrorReportContext,
} from "@/kernel/diagnostics/sessionErrorStore";
import {
  useGeometryDiagnosticsResource,
  useMeshBuildCurrent,
  useMeshBuildLatestSuccessful,
} from "@/kernel/resources/geometryLifecycleResources";
import { resolveSessionAuthoringDiscretization } from "@/kernel/resources/sessionDiscretization";
import {
  useCommandQueueResource,
  useCurrentRunResource,
} from "@/kernel/resources/studyRuntimeResources";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import { useSimulationPreparation } from "@/kernel/resources/useSimulationPreparation";
import { buildProblemsProjection } from "@/modules/footer/public";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";

type CategoryFilter = "all" | SessionErrorCategory;

const FILTER_OPTIONS: ReadonlyArray<{ id: CategoryFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "frontend", label: "Frontend" },
  { id: "backend", label: "Backend" },
  { id: "api", label: "API / WS" },
  { id: "model", label: "Model" },
];

const EMPTY_RECORDED_ERRORS: readonly SessionErrorEntry[] = [];

export function ExplorerErrorsPanel() {
  const recorded = useSessionErrors();
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [query, setQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  const sessionMeta = useSessionStatusSelector(
    (resource) => {
      const status = resource.data;
      if (!status) return null;
      return {
        discretization: resolveSessionAuthoringDiscretization(status),
        meshRevision: status.resources.mesh_revision ?? null,
        sceneRevision: status.resources.scene_revision ?? null,
        sessionId: status.session?.session_id ?? null,
        sessionName: status.session?.name ?? null,
      };
    },
    {
      isEqual: (previous, next) =>
        previous?.sessionId === next?.sessionId &&
        previous?.sessionName === next?.sessionName &&
        previous?.discretization === next?.discretization &&
        previous?.sceneRevision === next?.sceneRevision &&
        previous?.meshRevision === next?.meshRevision,
    },
  );
  const activeSessionId = sessionMeta?.sessionId ?? null;
  const recordedMatchesSession = recorded.sessionId === activeSessionId;
  const currentRecordedEntries = recordedMatchesSession ? recorded.entries : EMPTY_RECORDED_ERRORS;
  const currentRecordedSessionId = recordedMatchesSession ? recorded.sessionId : activeSessionId;
  const currentRun = useCurrentRunResource({ enabled: true });

  // Pull live backend/model Problems so pre-existing server failures (e.g. failed
  // mesh_build commands or geometry diagnostics) are always included alongside
  // client-captured runtime and HTTP/WS errors.
  const commandQueue = useCommandQueueResource({ enabled: true });
  const geometryDiagnostics = useGeometryDiagnosticsResource({ enabled: true });
  const latestSuccessfulMesh = useMeshBuildLatestSuccessful({ enabled: true });
  const meshBuild = useMeshBuildCurrent({ enabled: true });
  const preparation = useSimulationPreparation();

  const liveBackendEntries = useMemo<SessionErrorEntry[]>(() => {
    const projection = buildProblemsProjection({
      commandQueue: commandQueue.data,
      geometryDiagnostics: geometryDiagnostics.data,
      latestSuccessfulMesh: latestSuccessfulMesh.data,
      meshBuild: meshBuild.data,
      preparation: preparation.data,
      resources: [],
    });
    return projection.rows
      .filter((row) => row.severity === "error" || row.severity === "warning")
      .map((row) => {
        const category: SessionErrorCategory =
          row.source.toLowerCase().includes("geometry") ||
          row.source.toLowerCase().includes("model")
            ? "model"
            : "backend";
        const title = `${row.source}: ${row.code || row.severity}`;
        const message = row.message || row.detail || "Backend diagnostic reported.";
        const detail =
          row.detail && row.detail !== row.message
            ? `${row.detail}${row.revision ? ` (rev ${row.revision})` : ""}`
            : row.revision
              ? `Revision: ${row.revision}`
              : null;
        return {
          category,
          code: row.code || null,
          count: 1,
          detail,
          fingerprint: buildSessionErrorFingerprint({
            category,
            code: row.code || null,
            message,
            path: row.id,
            source: `backend:${row.source}`,
            title,
          }),
          firstSeenMs: 0,
          id: `problem:${row.id}`,
          lastSeenMs: 0,
          message,
          path: row.id,
          requestId: null,
          sessionId: sessionMeta?.sessionId ?? currentRecordedSessionId,
          severity: row.severity === "warning" ? "warning" : "error",
          source: `backend:${row.source}`,
          title,
        };
      });
  }, [
    commandQueue.data,
    geometryDiagnostics.data,
    latestSuccessfulMesh.data,
    meshBuild.data,
    preparation.data,
    currentRecordedSessionId,
    sessionMeta?.sessionId,
  ]);

  const allEntries = useMemo(
    () => mergeErrorLists(currentRecordedEntries, liveBackendEntries),
    [currentRecordedEntries, liveBackendEntries],
  );

  const categoryCounts = useMemo(() => {
    const counts: Record<CategoryFilter, number> = {
      all: allEntries.length,
      api: 0,
      backend: 0,
      frontend: 0,
      model: 0,
    };
    for (const entry of allEntries) {
      counts[entry.category] += 1;
    }
    return counts;
  }, [allEntries]);

  const visibleEntries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return allEntries.filter((entry) => {
      if (categoryFilter !== "all" && entry.category !== categoryFilter) {
        return false;
      }
      if (!needle) return true;
      return (
        entry.title.toLowerCase().includes(needle) ||
        entry.message.toLowerCase().includes(needle) ||
        (entry.code?.toLowerCase().includes(needle) ?? false) ||
        (entry.path?.toLowerCase().includes(needle) ?? false) ||
        entry.source.toLowerCase().includes(needle) ||
        (entry.detail?.toLowerCase().includes(needle) ?? false)
      );
    });
  }, [allEntries, categoryFilter, query]);

  const reportContext = useMemo<SessionErrorReportContext>(
    () => ({
      discretization: sessionMeta?.discretization ?? null,
      meshRevision: sessionMeta?.meshRevision ?? null,
      runId: currentRun.data?.run_id ?? null,
      sceneRevision: sessionMeta?.sceneRevision ?? null,
      sessionId: sessionMeta?.sessionId ?? currentRecordedSessionId,
      sessionName: sessionMeta?.sessionName ?? null,
      url: typeof window !== "undefined" ? window.location.href : null,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
      viewport:
        typeof window !== "undefined"
          ? `${window.innerWidth}×${window.innerHeight}`
          : null,
    }),
    [currentRun.data?.run_id, currentRecordedSessionId, sessionMeta],
  );

  const flashCopied = useCallback((id: string) => {
    setCopiedId(id);
    if (copyTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(copyTimerRef.current);
    }
    if (typeof window !== "undefined") {
      copyTimerRef.current = window.setTimeout(() => {
        setCopiedId(null);
        copyTimerRef.current = null;
      }, 2_000);
    }
  }, []);

  const handleCopyFullReport = useCallback(async () => {
    const targetEntries = visibleEntries.length > 0 ? visibleEntries : allEntries;
    const markdown = formatSessionErrorsForAiReport(targetEntries, reportContext);
    await writeClipboardText(markdown);
    flashCopied("__all__");
  }, [allEntries, flashCopied, reportContext, visibleEntries]);

  const handleCopySingle = useCallback(
    async (entry: SessionErrorEntry) => {
      const markdown = formatSingleSessionErrorForAi(entry, reportContext);
      await writeClipboardText(markdown);
      flashCopied(entry.id);
    },
    [flashCopied, reportContext],
  );

  const handleDownloadReport = useCallback(() => {
    const targetEntries = visibleEntries.length > 0 ? visibleEntries : allEntries;
    const markdown = formatSessionErrorsForAiReport(targetEntries, reportContext);
    const slug = (reportContext.sessionId ?? "session").replace(/[^a-zA-Z0-9_-]+/g, "-");
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `fullmag-error-report-${slug}.md`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [allEntries, reportContext, visibleEntries]);

  const errorTotal = allEntries.filter((e) => e.severity === "error").length;
  const warningTotal = allEntries.filter((e) => e.severity === "warning").length;
  const syncMessage = !recordedMatchesSession || !recorded.sessionId
    ? null
    : recorded.syncStatus === "offline"
      ? `Offline. ${recorded.pendingClear ? "The clear is queued. " : ""}${recorded.pendingCount > 0 ? `${recorded.pendingCount} pending diagnostic${recorded.pendingCount === 1 ? " is" : "s are"} saved for retry.` : "History will refresh when the connection returns."}`
      : recorded.pendingClear
        ? "Clearing saved session error history…"
        : recorded.pendingCount > 0
          ? `Saving ${recorded.pendingCount} pending diagnostic${recorded.pendingCount === 1 ? "" : "s"}…`
          : recorded.syncStatus === "loading"
            ? "Loading saved session error history…"
            : null;

  return (
    <div
      className="fm-explorer-errors"
      data-testid="explorer-errors-panel"
    >
      <section
        aria-label="Session error summary and AI export"
        className="fm-explorer-errors__summary"
      >
        <div className="fm-explorer-errors__summary-head">
          <div className="fm-explorer-errors__counts">
            <Badge variant={errorTotal > 0 ? "danger" : "success"}>
              {errorTotal} {errorTotal === 1 ? "error" : "errors"}
            </Badge>
            {warningTotal > 0 ? (
              <Badge variant="warning">
                {warningTotal} {warningTotal === 1 ? "warning" : "warnings"}
              </Badge>
            ) : null}
          </div>
          <div className="fm-explorer-errors__summary-tools">
            <Button
              aria-label="Download Markdown error report"
              disabled={allEntries.length === 0}
              size="icon"
              title="Download .md report"
              type="button"
              variant="ghost"
              onClick={handleDownloadReport}
            >
              <Download aria-hidden="true" size={13} />
            </Button>
            <Button
              aria-label="Clear recorded session errors"
              disabled={currentRecordedEntries.length === 0}
              size="icon"
              title="Clear recorded session errors"
              type="button"
              variant="ghost"
              onClick={() => sessionErrorStore.clear()}
            >
              <Trash2 aria-hidden="true" size={13} />
            </Button>
          </div>
        </div>

        <Button
          className="fm-explorer-errors__copy-report"
          size="sm"
          type="button"
          variant="primary"
          onClick={() => {
            void handleCopyFullReport();
          }}
        >
          {copiedId === "__all__" ? (
            <>
              <Check aria-hidden="true" size={13} />
              <span>Copied AI report</span>
            </>
          ) : (
            <>
              <Copy aria-hidden="true" size={13} />
              <span>Copy AI Report</span>
            </>
          )}
        </Button>
      </section>

      {syncMessage ? <p role="status">{syncMessage}</p> : null}

      <div className="fm-explorer-errors__filters">
        <div
          aria-label="Filter errors by category"
          className="fm-explorer-errors__pills"
          role="group"
        >
          {FILTER_OPTIONS.map(({ id, label }) => {
            const count = categoryCounts[id];
            const active = categoryFilter === id;
            return (
              <button
                aria-pressed={active}
                className="fm-explorer-errors__pill"
                data-active={active ? "true" : "false"}
                key={id}
                type="button"
                onClick={() => setCategoryFilter(id)}
              >
                <span>{label}</span>
                {count > 0 ? (
                  <span className="fm-explorer-errors__pill-count">{count}</span>
                ) : null}
              </button>
            );
          })}
        </div>

        <label className="fm-explorer-filter fm-explorer-errors__search">
          <Search
            aria-hidden="true"
            className="fm-explorer-filter__search-icon"
            size={13}
          />
          <input
            aria-label="Filter recorded errors"
            placeholder="Search errors, codes, endpoints…"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
      </div>

      <div className="fm-explorer-errors__list">
        {visibleEntries.length === 0 ? (
          <div className="fm-explorer-errors__empty" role="status">
            <CheckCircle2
              aria-hidden="true"
              className="fm-explorer-errors__empty-icon"
              size={20}
            />
            <strong>
              {allEntries.length === 0
                ? "No errors recorded"
                : "No matching errors"}
            </strong>
            <p>
              {allEntries.length === 0
                ? "Frontend exceptions, API/WebSocket failures, backend commands, and model diagnostics are captured automatically for this session."
                : "Try clearing the search query or switching to All categories."}
            </p>
          </div>
        ) : (
          visibleEntries.map((entry) => (
            <article
              className="fm-explorer-errors__card"
              data-category={entry.category}
              data-severity={entry.severity}
              key={entry.id}
            >
              <div className="fm-explorer-errors__card-head">
                <div className="fm-explorer-errors__card-badges">
                  {entry.severity === "error" ? (
                    <AlertOctagon
                      aria-hidden="true"
                      className="fm-explorer-errors__sev-icon--error"
                      size={13}
                    />
                  ) : (
                    <AlertTriangle
                      aria-hidden="true"
                      className="fm-explorer-errors__sev-icon--warning"
                      size={13}
                    />
                  )}
                  <Badge variant={entry.severity === "error" ? "danger" : "warning"}>
                    {sessionErrorCategoryLabel(entry.category)}
                  </Badge>
                  {entry.count > 1 ? (
                    <Badge variant="secondary">×{entry.count}</Badge>
                  ) : null}
                </div>
                <div className="fm-explorer-errors__card-meta">
                  {entry.lastSeenMs > 0 ? (
                    <time dateTime={new Date(entry.lastSeenMs).toISOString()}>
                      {formatClockTime(entry.lastSeenMs)}
                    </time>
                  ) : (
                    <span>Live</span>
                  )}
                  <Button
                    aria-label={`Copy ${entry.title} for AI`}
                    size="icon"
                    title="Copy issue for AI"
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      void handleCopySingle(entry);
                    }}
                  >
                    {copiedId === entry.id ? (
                      <Check aria-hidden="true" size={12} />
                    ) : (
                      <Copy aria-hidden="true" size={12} />
                    )}
                  </Button>
                </div>
              </div>

              <h3 className="fm-explorer-errors__card-title">{entry.title}</h3>
              <p className="fm-explorer-errors__card-message">{entry.message}</p>

              {entry.code || entry.path ? (
                <div className="fm-explorer-errors__card-tags">
                  {entry.code ? <code>{entry.code}</code> : null}
                  {entry.path ? <code>{entry.path}</code> : null}
                </div>
              ) : null}

              {entry.detail ? (
                <details className="fm-explorer-errors__card-detail">
                  <summary>Technical details</summary>
                  <pre>{entry.detail}</pre>
                </details>
              ) : null}
            </article>
          ))
        )}
      </div>
    </div>
  );
}

function formatClockTime(timestampMs: number): string {
  try {
    return new Date(timestampMs).toLocaleTimeString([], {
      hour: "2-digit",
      hour12: false,
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

async function writeClipboardText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to execCommand fallback.
    }
  }
  if (typeof document !== "undefined") {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
    } finally {
      document.body.removeChild(textarea);
    }
  }
}
