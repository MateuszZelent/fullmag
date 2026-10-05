"use client";

import { Copy, FolderSearch, Play, Terminal, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { Button } from "@/shared/ui/Button";

import { selectScriptBanner } from "../model/bannerModel";
import { formatBytes, formatOpened } from "../model/recentIndex";
import { RUN_NEEDS_DESKTOP, isRunBusy } from "../model/scriptRun";
import { ACTOR_LABEL, scriptHistoryRows, scriptRunRows } from "../model/scriptEvents";
import {
  copyText,
  displayPath,
  formatDuration,
  formatLines,
  launchCommand,
  runChip,
} from "../model/scriptRowModel";
import type { WorkspaceItemDetailState } from "../model/useWorkspaceItems";
import { NEEDS_DESKTOP } from "../model/workspaceSource";
import { useScriptRun } from "../model/useScriptRun";
import { useScriptHistory, type ScriptHistoryState } from "../model/useWorkspaceScripts";
import type { ScriptDetail } from "../model/workspaceApiTypes";
import { thumbnailSource } from "../model/workspaceApiAdapters";
import type { WorkspaceEvent, WorkspaceItem, WorkspaceItemId } from "../model/workspaceItems";
import { ProjectThumb } from "../ui/ProjectThumb";
import { StatusPill } from "../ui/StatusPill";

import { ContextBanner } from "./ContextBanner";
import { KvGroup, chipList, kvRow, kvRowOrUnavailable, type KvRow } from "./KeyValueGroup";
import {
  InspectorActionBar,
  InspectorHeader,
  InspectorPanel,
  InspectorTabs,
  RunsTable,
  type MenuAction,
} from "./InspectorParts";
import { ScriptRunPanel } from "./ScriptRunPanel";

export type ScriptTab = "overview" | "history" | "runs";

const TABS: readonly { readonly id: ScriptTab; readonly label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "history", label: "History" },
  { id: "runs", label: "Runs" },
];

const DESKTOP_EVENT_LABEL: Readonly<Record<WorkspaceEvent["kind"], string>> = {
  open: "Opened",
  save: "Saved",
  run: "Run",
  create: "Created",
  import: "Imported",
  pin: "Pinned",
  unpin: "Unpinned",
  forget: "Removed from recent",
};

export const READ_ONLY_REASON = "The workspace database is read-only";

export interface ScriptInspectorProps {
  readonly item: WorkspaceItem;
  /** What the backend read from the file; idle/unavailable without the HTTP API. */
  readonly detail: WorkspaceItemDetailState;
  /** The database is from a newer Fullmag: pins and removals cannot be saved. */
  readonly readOnly: boolean;
  /** The desktop host's own id for this script, which Run in new window needs. */
  readonly desktopId: number | null;
  /** Each action resolves to a failure message, or null on success. */
  readonly onOpen: (id: WorkspaceItemId) => Promise<string | null>;
  readonly onReveal: (id: WorkspaceItemId) => Promise<string | null>;
  readonly onReadText: (
    id: WorkspaceItemId,
  ) => Promise<{ readonly text: string } | { readonly failure: string }>;
  readonly onTogglePin: (id: WorkspaceItemId, pinned: boolean) => Promise<string | null>;
  readonly onForget: (id: WorkspaceItemId) => void;
  /** Called when a run started here has ended, so the list re-reads its last run. */
  readonly onRunFinished?: () => void;
  /** Selects a result folder in the list (a row of the Runs tab). */
  readonly onSelectResult?: (id: string) => void;
  /** Builds a thumbnail URL for the latest result's preview; omitted, none is shown. */
  readonly thumbnailUrl?: (id: string) => string;
  /** The tab shown first (a deep link, or a test); Overview by default. */
  readonly initialTab?: ScriptTab;
}

function scriptDetailOf(detail: WorkspaceItemDetailState): ScriptDetail | undefined {
  return detail.kind === "ready" && detail.answer.detail?.kind === "script"
    ? detail.answer.detail
    : undefined;
}

function DesktopHistory({ history }: { readonly history: ScriptHistoryState }) {
  if (history.kind === "loading") {
    return <p className="fm-start-inspector__note">Reading the history…</p>;
  }
  if (history.kind === "unavailable") {
    return <p className="fm-start-inspector__note">The history is read by the desktop app or the backend.</p>;
  }
  if (history.kind === "error") {
    return <p className="fm-start-inspector__note">Could not read the history: {history.message}</p>;
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
            <span className="fm-start-timeline__kind">{DESKTOP_EVENT_LABEL[event.kind]}</span>
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

function detailNote(detail: WorkspaceItemDetailState): string | null {
  switch (detail.kind) {
    case "loading":
      return "Reading the file…";
    case "error":
      return `Could not read the script details: ${detail.message}`;
    case "unavailable":
    case "idle":
      return "Syntax, imports and environment reads are checked by a Fullmag backend that serves the workspace database.";
    case "ready":
      return null;
  }
}

/** Facts from the list row plus, when the backend read the file, its own. */
export function scriptFacts(item: WorkspaceItem, script: ScriptDetail | undefined): KvRow[] {
  const rows: KvRow[] = [];
  const lines = formatLines(item);
  if (lines) rows.push({ label: "Lines", value: lines });
  const size = item.sizeBytes ?? script?.bytes;
  if (size !== undefined) rows.push({ label: "Size", value: formatBytes(size) });
  if (item.modifiedAt) rows.push({ label: "Modified", value: formatOpened(item.modifiedAt) });
  if (item.firstSeenAt) rows.push({ label: "First seen", value: formatOpened(item.firstSeenAt) });
  rows.push({
    label: "Used",
    value: item.useCount === 1 ? "1 time" : `${item.useCount.toLocaleString("en-US")} times`,
  });
  const usesFullmag = item.meta.usesFullmag ?? script?.usesFullmag;
  rows.push({
    label: "Uses fullmag",
    value: usesFullmag === undefined ? "Unknown" : usesFullmag ? "Yes" : "No",
  });
  if (script) {
    rows.push(...kvRowOrUnavailable("Encoding", script.encoding));
    rows.push(...kvRowOrUnavailable("SHA-256", script.sha256 ? script.sha256.slice(0, 12) : undefined));
  }
  return rows;
}

/** The checks the backend ran on the file: parse, imports, environment. */
export function scriptChecks(script: ScriptDetail): KvRow[] {
  const notChecked = script.syntax === undefined && script.syntaxChecked === false;
  const syntax = notChecked
    ? "not checked"
    : script.syntax
    ? script.syntax.ok
      ? "No syntax errors"
      : `Error${script.syntax.line !== undefined ? ` at line ${script.syntax.line}` : ""}${script.syntax.message ? `: ${script.syntax.message}` : ""}`
    : undefined;
  // "Not found" is relative to the interpreter the backend chose: a run may use another.
  const imports = script.unresolvedImports
    ? script.unresolvedImports.length === 0
      ? "All found by the interpreter"
      : chipList(script.unresolvedImports)
    : script.imports
      ? script.imports.length === 0
        ? "None"
        : chipList(script.imports)
      : undefined;
  const env = script.envReads
    ? script.envReads.length === 0
      ? "None"
      : chipList(script.envReads)
    : undefined;
  return [
    ...kvRowOrUnavailable("Syntax", syntax),
    ...kvRowOrUnavailable(
      script.unresolvedImports ? "Imports not found" : script.syntaxChecked ? "Imports" : "Imports (line scan)",
      imports,
    ),
    ...kvRowOrUnavailable("Environment reads", env),
    ...(script.degraded && script.degradedReason
      ? [{ label: "Checked by", value: <span title={script.degradedReason}>line scan only</span> }]
      : []),
  ];
}

export interface ScriptMenus {
  readonly more: readonly MenuAction[];
  readonly split: readonly MenuAction[];
}

/** The two menus of the inspector, as data so their reasons are testable. */
export function scriptMenus(input: {
  readonly item: WorkspaceItem;
  readonly readOnly: boolean;
  readonly busy: boolean;
  /** Why the desktop-only actions are unavailable (no desktop host); null when they work. */
  readonly desktopReason: string | null;
  readonly onCopyPath: () => void;
  readonly onReveal: () => void;
  readonly onCopyScript: () => void;
  readonly onCopyCommand: () => void;
  readonly onForget: () => void;
}): ScriptMenus {
  const missing = input.item.status === "missing";
  const fileGone = missing ? "The file is missing." : null;
  return {
    more: [
      { id: "copy-path", label: "Copy path", icon: <Copy aria-hidden="true" size={14} />, onSelect: input.onCopyPath },
      {
        id: "reveal-script",
        label: "Reveal in folder",
        icon: <FolderSearch aria-hidden="true" size={14} />,
        onSelect: input.onReveal,
        disabledReason:
          fileGone ?? input.desktopReason ?? (input.busy ? "Another action is running" : null),
      },
      {
        id: "forget-script",
        label: "Remove from recent",
        icon: <Trash2 aria-hidden="true" size={14} />,
        onSelect: input.onForget,
        disabledReason: input.readOnly ? READ_ONLY_REASON : null,
        separatorBefore: true,
      },
    ],
    split: [
      {
        id: "copy-script",
        label: "Copy script",
        icon: <Copy aria-hidden="true" size={14} />,
        onSelect: input.onCopyScript,
        disabledReason:
          fileGone ?? input.desktopReason ?? (input.busy ? "Another action is running" : null),
      },
      {
        id: "copy-command",
        label: "Copy launch command",
        icon: <Terminal aria-hidden="true" size={14} />,
        onSelect: input.onCopyCommand,
      },
    ],
  };
}

/**
 * What the start screen knows about a script, and what it can do with it.
 * Open script records the open. Run in new window reads the file's static
 * facts (nothing executes), shows them, and only then asks the host, which
 * shows its own native confirmation before it starts a separate process.
 */
export function ScriptInspector({
  item,
  detail,
  readOnly,
  desktopId,
  onOpen,
  onReveal,
  onReadText,
  onTogglePin,
  onForget,
  onRunFinished,
  onSelectResult,
  thumbnailUrl,
  initialTab = "overview",
}: ScriptInspectorProps) {
  const baseId = useId();
  const [tab, setTab] = useState<ScriptTab>(initialTab);
  const runner = useScriptRun(desktopId ?? -1, onRunFinished);
  const [notice, setNotice] = useState<{ readonly tone: "info" | "error"; readonly text: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  // The list re-read moves `lastUsedAt` when anything recorded an event.
  const history = useScriptHistory(desktopId, `${item.lastUsedAt}|${item.useCount}|${item.pinned}`);
  const script = scriptDetailOf(detail);
  const answer = detail.kind === "ready" ? detail.answer : undefined;
  const missing = item.status === "missing";
  const path = displayPath(item.path);
  const lastRun = item.meta.lastRun ?? script?.lastRun;
  const chip = runChip(lastRun);
  const summary = item.meta.summary ?? script?.summary;
  const banner = selectScriptBanner({
    status: item.status,
    path,
    syntax: script?.syntax,
    readError: script?.readError,
  });

  // A confirmation clears itself; an error stays until the next action.
  useEffect(() => {
    if (notice?.tone !== "info") return undefined;
    const timer = setTimeout(() => setNotice(null), 2400);
    return () => clearTimeout(timer);
  }, [notice]);

  const flash = (text: string) => setNotice({ tone: "info", text });

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

  const runDisabledReason = !runner.hostAvailable
    ? RUN_NEEDS_DESKTOP
    : desktopId === null
      ? "The desktop app has no record of this script. Use Open script… to add it"
      : missing
        ? "The file is missing"
        : isRunBusy(runner.phase)
          ? "A run for this script is in progress"
          : null;

  const desktopReason = runner.hostAvailable ? null : NEEDS_DESKTOP;
  const menus = scriptMenus({
    item,
    readOnly,
    busy,
    desktopReason,
    onCopyPath: () => void copy(path, "Path"),
    onReveal: () => void run(() => onReveal(item.id)),
    onCopyScript: copyScript,
    onCopyCommand: () => void copy(launchCommand(item.path), "Launch command"),
    onForget: () => onForget(item.id),
  });

  const latestPreview = answer?.linkedResults.find((result) => result.hasThumbnail);
  const previewSrc = latestPreview ? thumbnailSource(latestPreview, thumbnailUrl) : undefined;

  const note = detailNote(detail);
  const runRows = scriptRunRows(answer?.events ?? [], answer?.linkedResults ?? []);
  const historyRows = scriptHistoryRows(answer?.events ?? []);
  const showRunNote = runner.phase.kind !== "idle";

  return (
    <aside aria-label="Script details" className="fm-start__inspector fm-start-inspector" data-kind="script">
      <div
        aria-label={previewSrc ? `Last result of ${item.name}` : undefined}
        className="fm-start-preview"
        role={previewSrc ? "img" : undefined}
      >
        <span className="fm-start-preview__label">Last result</span>
        <ProjectThumb eager size="preview" src={previewSrc} status={item.status === "missing" ? "missing" : "ready"} />
      </div>

      <InspectorHeader
        chips={
          <>
            <span className="fm-start-badge fm-start-badge--script" title="Python script">
              .py
            </span>
            {item.status !== "ready" ? <StatusPill status={item.status} /> : null}
            {chip ? <StatusPill label={chip.label} status={chip.status} title={chip.title} /> : null}
            {script?.syntax && !script.syntax.ok ? (
              <StatusPill label="Syntax error" status="failed" title="Python could not parse the script" />
            ) : null}
          </>
        }
        moreActions={menus.more}
        name={item.name}
        onCopyFailed={() => setNotice({ tone: "error", text: "Could not copy the path to the clipboard." })}
        onTogglePin={() => void run(() => onTogglePin(item.id, !item.pinned))}
        path={path}
        pinDisabledReason={readOnly ? READ_ONLY_REASON : null}
        pinned={item.pinned}
      />

      <ContextBanner banner={banner} />

      <InspectorTabs baseId={baseId} label="Script sections" onChange={setTab} tabs={TABS} value={tab} />

      <InspectorPanel baseId={baseId} tab={tab}>
        {showRunNote ? <ScriptRunPanel controller={runner} /> : null}

        {tab === "overview" ? (
          <>
            {summary ? (
              <section className="fm-start-kv">
                <h3 className="fm-start-kv__title">Summary</h3>
                <p className="fm-start-inspector__note">{summary}</p>
              </section>
            ) : null}
            <KvGroup rows={scriptFacts(item, script)} title="Facts" />
            {script ? (
              <KvGroup rows={scriptChecks(script)} title="Checks" />
            ) : note ? (
              <p className="fm-start-inspector__note">{note}</p>
            ) : null}
            <section className="fm-start-kv">
              <h3 className="fm-start-kv__title">Last run</h3>
              {lastRun ? (
                <dl className="fm-start-kv__grid">
                  {[
                    ...kvRow("Outcome", chip?.label ?? lastRun.status),
                    ...kvRow("When", lastRun.at ? formatOpened(lastRun.at) : undefined),
                    ...kvRow("Duration", formatDuration(lastRun.durationSeconds) ?? undefined),
                    ...kvRow("Device", lastRun.device),
                  ].map((row) => (
                    <div className="fm-start-kv__row" key={row.label}>
                      <dt>{row.label}</dt>
                      <dd>{row.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="fm-start-inspector__note">
                  No run is recorded. Runs started here or with the fullmag command line appear here.
                </p>
              )}
            </section>
          </>
        ) : tab === "history" ? (
          answer ? (
            historyRows.length === 0 ? (
              <p className="fm-start-inspector__note">Nothing has been recorded for this script yet.</p>
            ) : (
              <ol className="fm-start-timeline">
                {historyRows.map((row) => (
                  <li
                    className={`fm-start-timeline__item fm-start-timeline__item--${row.kind}`}
                    key={row.key}
                  >
                    <span className="fm-start-timeline__head">
                      <span className="fm-start-timeline__kind">{row.label}</span>
                      <span className="fm-start-timeline__meta">{formatOpened(row.at)}</span>
                    </span>
                    {[row.actor, row.summary].filter(Boolean).length > 0 ? (
                      <span className="fm-start-timeline__meta">
                        {[row.actor, row.summary].filter(Boolean).join(" · ")}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>
            )
          ) : detail.kind === "loading" ? (
            <p className="fm-start-inspector__note">Reading the history…</p>
          ) : (
            <DesktopHistory history={history} />
          )
        ) : answer ? (
          runRows.length === 0 ? (
            <p className="fm-start-inspector__note">
              No run is recorded. Runs started here or with the fullmag command line appear here.
            </p>
          ) : (
            <RunsTable
              formatOutput={formatBytes}
              rows={runRows.map((row) => ({
                key: row.key,
                label: row.label,
                status: row.status,
                statusWord: row.statusWord,
                startedAt: row.startedAt,
                durationSeconds: row.durationSeconds,
                outputBytes: row.outputBytes,
                onSelect:
                  row.resultId && onSelectResult
                    ? () => onSelectResult(row.resultId ?? "")
                    : undefined,
              }))}
            />
          )
        ) : (
          <p className="fm-start-inspector__note">
            {detail.kind === "loading"
              ? "Reading the runs…"
              : "Runs and the result folders they wrote are listed by a Fullmag backend that serves the workspace database."}
          </p>
        )}
      </InspectorPanel>

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

      <InspectorActionBar
        externalDisabledReason={missing ? "The file is missing." : desktopReason}
        externalLabel="Reveal in folder"
        onExternal={() => void run(() => onReveal(item.id))}
        onPrimary={() => void run(() => onOpen(item.id), "Recorded as opened.")}
        primaryAction="open-script"
        primaryDisabledReason={
          missing ? "The file is missing." : (desktopReason ?? (busy ? "Another action is running" : null))
        }
        primaryLabel="Open script"
        splitActions={menus.split}
      >
        <Button
          aria-describedby={runDisabledReason ? `${baseId}-run-reason` : undefined}
          className="fm-start-inspector__run"
          data-action="run-script"
          disabled={runDisabledReason !== null}
          onClick={() => {
            setTab("runs");
            void runner.prepare();
          }}
          title={runDisabledReason ?? undefined}
          type="button"
          variant="secondary"
        >
          <Play aria-hidden="true" size={14} />
          Run in new window
        </Button>
        {runDisabledReason ? (
          <p className="fm-start-inspector__note" id={`${baseId}-run-reason`}>
            {runDisabledReason}.
          </p>
        ) : null}
      </InspectorActionBar>
    </aside>
  );
}
