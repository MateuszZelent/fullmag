"use client";

import { Copy } from "lucide-react";
import { useState } from "react";

import { Button } from "@/shared/ui/Button";

import { formatBytes, formatOpened } from "../model/recentIndex";
import { generateBibtex, type HistoryEntry, type Provenance, type RunRecord, type RunStatus } from "../model/provenance";
import type { ProjectStatus, RecentEntry } from "../model/types";
import { StatusPill } from "../ui/StatusPill";

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

function duration(seconds: number | undefined): string {
  if (seconds === undefined) return "—";
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

export function RunsPanel({ provenance }: { readonly provenance: Provenance }) {
  if (provenance.runs.length === 0) {
    return <p className="fm-start-inspector__note">{emptyNote(provenance.recorded, "runs")}</p>;
  }
  return (
    <table className="fm-start-formats fm-start-runs">
      <caption className="fm-start-visually-hidden">Runs</caption>
      <thead>
        <tr>
          <th scope="col">Run</th>
          <th scope="col">Started</th>
          <th scope="col">Duration</th>
          <th scope="col">Output</th>
        </tr>
      </thead>
      <tbody>
        {provenance.runs.map((run: RunRecord) => {
          const pill = RUN_PILL[run.status];
          return (
            <tr key={run.runId} title={run.error}>
              <th scope="row">
                <StatusPill label={run.runId} status={pill.status} title={`${pill.label}${run.error ? `: ${run.error}` : ""}`} />
              </th>
              <td>{formatOpened(run.startedAt)}</td>
              <td>{duration(run.durationSeconds)}</td>
              <td>{run.outputBytes !== undefined ? formatBytes(run.outputBytes) : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
