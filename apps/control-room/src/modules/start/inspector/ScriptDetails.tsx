"use client";

import { Copy, FileCode2, FolderSearch, Play, Star, Terminal, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/shared/ui/Button";

import { formatBytes, formatOpened } from "../model/recentIndex";
import {
  RUN_SCRIPT_UNAVAILABLE,
  copyText,
  displayPath,
  formatDuration,
  formatLines,
  launchCommand,
  runChip,
} from "../model/scriptRowModel";
import { useScriptHistory, type ScriptHistoryState } from "../model/useWorkspaceScripts";
import type { WorkspaceEvent, WorkspaceItem } from "../model/workspaceItems";
import { StatusPill } from "../ui/StatusPill";

const EVENT_LABEL: Readonly<Record<WorkspaceEvent["kind"], string>> = {
  open: "Opened",
  save: "Saved",
  run: "Run",
  create: "Created",
  import: "Imported",
  pin: "Pinned",
  unpin: "Unpinned",
  forget: "Removed from recent",
};

const ACTOR_LABEL: Readonly<Record<string, string>> = {
  desktop: "desktop app",
  cli: "command line",
  python: "Python",
  web: "browser",
};

export interface ScriptDetailsProps {
  readonly item: WorkspaceItem;
  /** The database is from a newer Fullmag: pins and removals cannot be saved. */
  readonly readOnly: boolean;
  /** Each action resolves to a failure message, or null on success. */
  readonly onOpen: (id: number) => Promise<string | null>;
  readonly onReveal: (id: number) => Promise<string | null>;
  readonly onReadText: (id: number) => Promise<{ readonly text: string } | { readonly failure: string }>;
  readonly onTogglePin: (id: number, pinned: boolean) => Promise<string | null>;
  readonly onForget: (id: number) => void;
}

interface Row {
  readonly label: string;
  readonly value: string;
}

function facts(item: WorkspaceItem): Row[] {
  const rows: Row[] = [];
  const lines = formatLines(item);
  if (lines) rows.push({ label: "Lines", value: lines });
  if (item.sizeBytes !== undefined) rows.push({ label: "Size", value: formatBytes(item.sizeBytes) });
  if (item.modifiedAt) rows.push({ label: "Modified", value: formatOpened(item.modifiedAt) });
  if (item.firstSeenAt) rows.push({ label: "First seen", value: formatOpened(item.firstSeenAt) });
  rows.push({
    label: "Used",
    value: item.useCount === 1 ? "1 time" : `${item.useCount.toLocaleString("en-US")} times`,
  });
  rows.push({
    label: "Uses fullmag",
    value: item.meta.usesFullmag === undefined ? "Unknown" : item.meta.usesFullmag ? "Yes" : "No",
  });
  return rows;
}

function HistoryList({ history }: { readonly history: ScriptHistoryState }) {
  if (history.kind === "loading") {
    return <p className="fm-start-inspector__note">Reading the history…</p>;
  }
  if (history.kind === "unavailable") {
    return <p className="fm-start-inspector__note">The history is read by the desktop app.</p>;
  }
  if (history.kind === "error") {
    return (
      <p className="fm-start-inspector__note">Could not read the history: {history.message}</p>
    );
  }
  if (history.events.length === 0) {
    return <p className="fm-start-inspector__note">Nothing has been recorded for this script yet.</p>;
  }
  return (
    <ol className="fm-start-timeline">
      {history.events.map((event) => (
        <li
          className={`fm-start-timeline__item fm-start-timeline__item--${event.kind}`}
          key={event.key}
        >
          <span className="fm-start-timeline__head">
            <span className="fm-start-timeline__kind">{EVENT_LABEL[event.kind]}</span>
            <span className="fm-start-timeline__meta">{formatOpened(event.at)}</span>
          </span>
          <span className="fm-start-timeline__meta">
            {[ACTOR_LABEL[event.actor] ?? event.actor, event.detail].filter(Boolean).join(" · ")}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * What the start screen knows about a script, and what it can do with it.
 * Fullmag cannot execute a script from here yet: Open script records the open
 * and Run in new window is shown disabled, with the reason, so the position
 * and semantics are fixed for the phase that enables it.
 */
export function ScriptDetails({
  item,
  readOnly,
  onOpen,
  onReveal,
  onReadText,
  onTogglePin,
  onForget,
}: ScriptDetailsProps) {
  const baseId = useId();
  const [notice, setNotice] = useState<{ readonly tone: "info" | "error"; readonly text: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The list re-read moves `lastUsedAt` when anything recorded an event.
  const history = useScriptHistory(item.id, `${item.lastUsedAt}|${item.useCount}|${item.pinned}`);
  const missing = item.status === "missing";
  const path = displayPath(item.path);
  const chip = runChip(item.meta.lastRun);
  const lastRun = item.meta.lastRun;

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  const flash = (text: string) => {
    setNotice({ tone: "info", text });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 2400);
  };

  const run = async (action: () => Promise<string | null>, done?: string) => {
    setBusy(true);
    const failure = await action();
    setBusy(false);
    if (failure) setNotice({ tone: "error", text: failure });
    else if (done) flash(done);
    else setNotice(null);
  };

  const copy = async (text: string, label: string) => {
    const copied = await copyText(text);
    if (copied) flash(`${label} copied.`);
    else setNotice({ tone: "error", text: `Could not copy ${label.toLowerCase()} to the clipboard.` });
  };

  const copyScript = () =>
    void run(async () => {
      const result = await onReadText(item.id);
      if ("failure" in result) return result.failure;
      return (await copyText(result.text)) ? null : "Could not copy the script to the clipboard.";
    }, "Script copied.");

  const rows = facts(item);

  return (
    <aside aria-label="Script details" className="fm-start__inspector fm-start-inspector" data-kind="script">
      <header className="fm-start-inspector__head">
        <div className="fm-start-inspector__title-row">
          <h2 className="fm-start-inspector__name">{item.name}</h2>
          <Button
            aria-label={item.pinned ? `Unpin ${item.name}` : `Pin ${item.name}`}
            aria-pressed={item.pinned}
            disabled={readOnly}
            onClick={() => void run(() => onTogglePin(item.id, !item.pinned))}
            size="icon"
            title={readOnly ? "The workspace database is read-only" : undefined}
            type="button"
            variant="ghost"
          >
            <Star aria-hidden="true" fill={item.pinned ? "currentColor" : "none"} size={14} />
          </Button>
        </div>
        <div className="fm-start-inspector__path">
          <span title={path}>{path}</span>
          <Button
            aria-label="Copy path"
            onClick={() => void copy(path, "Path")}
            size="icon"
            title="Copy path"
            type="button"
            variant="ghost"
          >
            <Copy aria-hidden="true" size={12} />
          </Button>
        </div>
        <div className="fm-start-chips">
          <span className="fm-start-badge fm-start-badge--script" title="Python script">
            .py
          </span>
          {item.status !== "ready" ? <StatusPill status={item.status} /> : null}
          {chip ? <StatusPill label={chip.label} status={chip.status} title={chip.title} /> : null}
        </div>
      </header>

      {missing ? (
        <div className="fm-start-banner fm-start-banner--warning" role="status">
          <div className="fm-start-banner__copy">
            <strong>The file is missing.</strong>
            <span className="fm-start-banner__detail">
              It is no longer at this path. Remove it from recent, or move it back.
            </span>
          </div>
        </div>
      ) : null}

      <div className="fm-start-inspector__body">
        {item.meta.summary ? (
          <section className="fm-start-kv">
            <h3 className="fm-start-kv__title">Summary</h3>
            <p className="fm-start-inspector__note">{item.meta.summary}</p>
          </section>
        ) : null}

        <section aria-labelledby={`${baseId}-facts`} className="fm-start-kv">
          <h3 className="fm-start-kv__title" id={`${baseId}-facts`}>
            Facts
          </h3>
          <dl className="fm-start-kv__grid">
            {rows.map((row) => (
              <div className="fm-start-kv__row" key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section aria-labelledby={`${baseId}-run`} className="fm-start-kv">
          <h3 className="fm-start-kv__title" id={`${baseId}-run`}>
            Last run
          </h3>
          {lastRun ? (
            <dl className="fm-start-kv__grid">
              <div className="fm-start-kv__row">
                <dt>Outcome</dt>
                <dd>{chip?.label ?? lastRun.status}</dd>
              </div>
              {lastRun.at ? (
                <div className="fm-start-kv__row">
                  <dt>When</dt>
                  <dd>{formatOpened(lastRun.at)}</dd>
                </div>
              ) : null}
              {formatDuration(lastRun.durationSeconds) ? (
                <div className="fm-start-kv__row">
                  <dt>Duration</dt>
                  <dd>{formatDuration(lastRun.durationSeconds)}</dd>
                </div>
              ) : null}
              {lastRun.device ? (
                <div className="fm-start-kv__row">
                  <dt>Device</dt>
                  <dd>{lastRun.device}</dd>
                </div>
              ) : null}
            </dl>
          ) : (
            <p className="fm-start-inspector__note">
              No run is recorded. Runs started with the fullmag command line appear here.
            </p>
          )}
        </section>

        <section aria-labelledby={`${baseId}-history`} className="fm-start-kv">
          <h3 className="fm-start-kv__title" id={`${baseId}-history`}>
            History
          </h3>
          <HistoryList history={history} />
        </section>
      </div>

      <div aria-live="polite" className="fm-start-visually-hidden" role="status">
        {notice?.tone === "info" ? notice.text : ""}
      </div>
      {notice ? (
        <div
          className={`fm-start-banner fm-start-banner--${notice.tone === "error" ? "danger" : "info"}`}
          role={notice.tone === "error" ? "alert" : undefined}
        >
          <div className="fm-start-banner__copy">{notice.text}</div>
        </div>
      ) : null}

      <footer className="fm-start-inspector__foot fm-start-inspector__foot--script">
        <div className="fm-start-inspector__actions">
          <Button
            className="fm-start-inspector__open"
            data-action="open-script"
            disabled={missing || busy}
            onClick={() =>
              void run(
                () => onOpen(item.id),
                "Recorded as opened. Fullmag cannot run scripts from the start screen yet.",
              )
            }
            title={missing ? "The file is missing." : undefined}
            type="button"
            variant="primary"
          >
            <FileCode2 aria-hidden="true" size={14} />
            Open script
          </Button>
          <Button
            aria-describedby={`${baseId}-run-reason`}
            data-action="run-script"
            disabled
            title={RUN_SCRIPT_UNAVAILABLE}
            type="button"
            variant="secondary"
          >
            <Play aria-hidden="true" size={14} />
            Run in new window
          </Button>
        </div>
        <p className="fm-start-inspector__note" id={`${baseId}-run-reason`}>
          {RUN_SCRIPT_UNAVAILABLE}.
        </p>
        <div className="fm-start-inspector__actions">
          <Button
            data-action="reveal-script"
            disabled={missing || busy}
            onClick={() => void run(() => onReveal(item.id))}
            size="sm"
            type="button"
            variant="secondary"
          >
            <FolderSearch aria-hidden="true" size={14} />
            Reveal in folder
          </Button>
          <Button
            data-action="copy-script"
            disabled={missing || busy}
            onClick={copyScript}
            size="sm"
            type="button"
            variant="secondary"
          >
            <Copy aria-hidden="true" size={14} />
            Copy script
          </Button>
          <Button
            data-action="copy-command"
            onClick={() => void copy(launchCommand(item.path), "Launch command")}
            size="sm"
            title={launchCommand(item.path)}
            type="button"
            variant="secondary"
          >
            <Terminal aria-hidden="true" size={14} />
            Copy launch command
          </Button>
          <Button
            data-action="forget-script"
            disabled={readOnly}
            onClick={() => onForget(item.id)}
            size="sm"
            title={readOnly ? "The workspace database is read-only" : "Remove from the recent list"}
            type="button"
            variant="ghost"
          >
            <Trash2 aria-hidden="true" size={14} />
            Forget
          </Button>
        </div>
      </footer>
    </aside>
  );
}
