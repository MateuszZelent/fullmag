"use client";

import { Activity, Copy, Download } from "lucide-react";
import { useState } from "react";

import { Button } from "@/shared/ui/Button";

import {
  RESULTS_DOWNLOAD_FOLDER_MISSING,
  RESULTS_DOWNLOAD_NO_BACKEND,
  RESULTS_DOWNLOAD_NO_FOLDER,
  startDownload,
} from "../model/downloadUrl";
import { formatBytes, formatOpened } from "../model/recentIndex";
import { resultChip } from "../model/resultModel";
import { metaNumber, metaString, type ApiWorkspaceItem } from "../model/workspaceApiTypes";
import { generateBibtex, type HistoryEntry, type Provenance, type RunRecord, type RunStatus } from "../model/provenance";
import type { ProjectStatus, RecentEntry } from "../model/types";
import { RunsTable, type RunRow } from "./InspectorParts";

const RUN_PILL: Readonly<Record<RunStatus, { status: ProjectStatus; label: string }>> = {
  queued: { status: "draft", label: "Queued" },
  running: { status: "running", label: "Running" },
  ready: { status: "ready", label: "Ready" },
  failed: { status: "failed", label: "Failed" },
  cancelled: { status: "draft", label: "Cancelled" },
};

const KIND_LABEL: Readonly<Record<HistoryEntry["kind"], string>> = {
  edit: "Edit",
  run: "Run",
  migrate: "Migration",
  import: "Import",
  restore: "Restore",
};

/** An empty tab says why: never recorded, or recorded and still empty. */
function emptyNote(recorded: boolean, what: string): string {
  return recorded
    ? `No ${what} have been recorded yet.`
    : `No ${what} are recorded: this project predates provenance tracking.`;
}

export function AuthorsPanel({ entry, provenance }: { readonly entry: RecentEntry; readonly provenance: Provenance }) {
  const [copied, setCopied] = useState(false);
  // The index carries the authors even before the archive is read.
  const authors = provenance.authors.length > 0 ? provenance.authors : (entry.authors ?? []);
  const year = new Date(entry.modifiedAt ?? entry.lastOpenedAt).getFullYear();
  const bibtex = generateBibtex({
    name: entry.name,
    authors,
    revision: entry.revision,
    year: Number.isFinite(year) ? year : new Date().getFullYear(),
    citation: provenance.citation,
  });
  const { doi } = provenance.citation;

  return (
    <>
      {authors.length === 0 ? (
        <p className="fm-start-inspector__note">{emptyNote(provenance.recorded, "authors")}</p>
      ) : (
        <ul className="fm-start-people">
          {authors.map((author) => (
            <li key={`${author.name}-${author.role}`}>
              <span className="fm-start-people__name">{author.name}</span>
              <span className="fm-start-chip">{author.role}</span>
              {author.affiliation ? (
                <span className="fm-start-people__meta">{author.affiliation}</span>
              ) : null}
              {author.orcid ? (
                <a
                  className="fm-start-link"
                  href={`https://orcid.org/${author.orcid}`}
                  rel="noreferrer"
                  target="_blank"
                >
                  ORCID {author.orcid}
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <section className="fm-start-kv">
        <h3 className="fm-start-kv__title">Cite this project</h3>
        <pre className="fm-start-bibtex">{bibtex}</pre>
        <div className="fm-start-bibtex__actions">
          <Button
            onClick={() => {
              void navigator.clipboard?.writeText(bibtex).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              });
            }}
            size="sm"
            type="button"
            variant="secondary"
          >
            <Copy aria-hidden="true" size={14} />
            {copied ? "Copied" : "Copy BibTeX"}
          </Button>
          {doi ? (
            <a className="fm-start-link" href={`https://doi.org/${doi}`} rel="noreferrer" target="_blank">
              DOI {doi}
            </a>
          ) : null}
        </div>
      </section>
    </>
  );
}

export function HistoryPanel({ provenance }: { readonly provenance: Provenance }) {
  if (provenance.history.length === 0) {
    return <p className="fm-start-inspector__note">{emptyNote(provenance.recorded, "changes")}</p>;
  }
  return (
    <ol className="fm-start-timeline">
      {provenance.history.map((item) => (
        <li className={`fm-start-timeline__item fm-start-timeline__item--${item.kind}`} key={`${item.revision}-${item.at}`}>
          <span className="fm-start-timeline__head">
            <span className="fm-start-timeline__kind">{KIND_LABEL[item.kind]}</span>
            <span className="fm-start-timeline__meta">
              rev {item.revision} · {formatOpened(item.at)}
              {item.by ? ` · ${item.by}` : ""}
            </span>
          </span>
          <span>{item.summary}</span>
          {item.changes ? (
            <ul className="fm-start-timeline__changes">
              {item.changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export interface RunsViewer {
  /** Why "Open results viewer" is disabled; null when it can run. */
  readonly disabledReason: string | null;
  readonly onOpen: () => void;
  readonly download: RunsDownload;
}

export interface RunsDownload {
  /** The zip of the newest linked result folder; null with the reason it cannot be offered. */
  readonly href: string | null;
  readonly reason: string | null;
}

/**
 * The download of a project's Runs tab is the newest linked result folder as a
 * zip (`GET /v2/workspace/items/{id}/archive`); linked folders arrive newest
 * first. A folder that is missing is skipped, not offered.
 */
export function resultsDownload(
  linkedResults: readonly ApiWorkspaceItem[],
  archiveUrl: ((id: string) => string) | undefined,
): RunsDownload {
  if (!archiveUrl) return { href: null, reason: RESULTS_DOWNLOAD_NO_BACKEND };
  if (linkedResults.length === 0) return { href: null, reason: RESULTS_DOWNLOAD_NO_FOLDER };
  const folder = linkedResults.find((item) => item.status !== "missing");
  if (!folder) return { href: null, reason: RESULTS_DOWNLOAD_FOLDER_MISSING };
  return { href: archiveUrl(folder.id), reason: null };
}

/**
 * The Runs tab of the sketch: Run | Started | Duration | Output, then Open
 * results viewer beside a download button. Result folders linked to the
 * project are rows too; selecting one shows it in the list.
 */
export function RunsPanel({
  provenance,
  linkedResults = [],
  onSelectResult,
  viewer,
}: {
  readonly provenance: Provenance;
  readonly linkedResults?: readonly ApiWorkspaceItem[];
  readonly onSelectResult?: (id: string) => void;
  readonly viewer?: RunsViewer;
}) {
  const runRows: RunRow[] = provenance.runs.map((run: RunRecord) => {
    const pill = RUN_PILL[run.status];
    return {
      key: run.runId,
      label: run.runId,
      status: pill.status,
      statusWord: `${pill.label}${run.error ? `: ${run.error}` : ""}`,
      title: run.error,
      startedAt: run.startedAt,
      durationSeconds: run.durationSeconds,
      outputBytes: run.outputBytes,
    };
  });
  const knownRunIds = new Set(provenance.runs.map((run) => run.runId));
  const folderRows: RunRow[] = linkedResults.flatMap((item): RunRow[] => {
    // A folder that carries a run's id is that run's output, not a second run.
    const runId = metaString(item, "run_id");
    if (runId && knownRunIds.has(runId)) return [];
    const chip = resultChip(item);
    return [
      {
        key: `result:${item.id}`,
        label: item.name,
        status: chip?.status ?? "draft",
        statusWord: chip?.label || chip?.title || "Result folder",
        startedAt: metaString(item, "started_at") ?? item.firstSeenAt,
        durationSeconds: metaNumber(item, "duration_seconds"),
        outputBytes: item.sizeBytes,
        onSelect: onSelectResult ? () => onSelectResult(item.id) : undefined,
      },
    ];
  });
  const rows = [...runRows, ...folderRows];
  if (rows.length === 0) {
    return <p className="fm-start-inspector__note">{emptyNote(provenance.recorded, "runs")}</p>;
  }
  return (
    <>
      <RunsTable formatOutput={formatBytes} rows={rows} />
      {viewer ? (
        <div className="fm-start-runs__actions">
          <Button
            data-action="open-results-viewer"
            disabled={viewer.disabledReason !== null}
            onClick={viewer.onOpen}
            size="sm"
            title={viewer.disabledReason ?? undefined}
            type="button"
            variant="secondary"
          >
            <Activity aria-hidden="true" size={14} />
            Open results viewer
          </Button>
          <Button
            aria-label="Download results"
            data-action="download-results"
            disabled={viewer.download.href === null}
            onClick={() => {
              if (viewer.download.href) startDownload(viewer.download.href);
            }}
            size="icon"
            title={viewer.download.reason ?? "Download the newest result folder as a zip"}
            type="button"
            variant="secondary"
          >
            <Download aria-hidden="true" size={14} />
          </Button>
        </div>
      ) : null}
    </>
  );
}
