"use client";

import { Copy, Download, FileCode2, FolderSearch, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { tauriInvoke } from "@/kernel/persistence/ProjectDocumentController";

import { selectResultBanner } from "../model/bannerModel";
import { RESULTS_DOWNLOAD_FOLDER_MISSING, RESULTS_DOWNLOAD_NO_BACKEND, startDownload } from "../model/downloadUrl";
import { formatSimTime } from "../model/continueModel";
import { formatBytes, formatOpened } from "../model/recentIndex";
import { resultChip, resultSourceName, stageLabel } from "../model/resultModel";
import { scriptHistoryRows } from "../model/scriptEvents";
import { copyText, displayPath } from "../model/scriptRowModel";
import type { WorkspaceItemDetailState } from "../model/useWorkspaceItems";
import { thumbnailSource } from "../model/workspaceApiAdapters";
import type { ApiItemDetailAnswer, ApiWorkspaceItem, ResultDetail } from "../model/workspaceApiTypes";
import { ProjectThumb } from "../ui/ProjectThumb";
import { StatusPill } from "../ui/StatusPill";

import { ContextBanner } from "./ContextBanner";
import {
  InspectorActionBar,
  InspectorHeader,
  InspectorPanel,
  InspectorTabs,
  type MenuAction,
} from "./InspectorParts";
import { KvGroup, chipList, kvRow, kvRowOrUnavailable, type KvRow } from "./KeyValueGroup";

export type ResultTab = "overview" | "stages" | "history";

const TABS: readonly { readonly id: ResultTab; readonly label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "stages", label: "Stages" },
  { id: "history", label: "History" },
];

const subscribeNever = () => () => undefined;
const serverInvoke = () => null;

export const RESULTS_VIEWER_NEEDS_SOURCE =
  "The results viewer opens the project that wrote this folder, and none is listed for it.";
export const RESULTS_VIEWER_SOURCE_IS_SCRIPT =
  "This folder was written by a script. The results viewer opens a project; run the script from its details to create one.";

export interface ViewerRoute {
  /** The project whose Results module shows the saved runs; null when there is none. */
  readonly project: ApiWorkspaceItem | null;
  /** Why "Open results viewer" is disabled; null when it can run. */
  readonly reason: string | null;
}

/**
 * The saved-results viewer is the Results module of an open project
 * (SavedResultsBrowser); there is no viewer for a bare folder. So the button
 * is live only when the folder is linked to the project that owns it.
 */
export function viewerRoute(
  item: Pick<ApiWorkspaceItem, "status">,
  answer: ApiItemDetailAnswer | undefined,
): ViewerRoute {
  if (item.status === "missing") return { project: null, reason: "The folder is missing." };
  const source = answer?.linkedSource;
  if (source?.kind === "project") {
    return source.status === "missing"
      ? { project: null, reason: "The source project is missing." }
      : { project: source, reason: null };
  }
  return {
    project: null,
    reason: source?.kind === "script" ? RESULTS_VIEWER_SOURCE_IS_SCRIPT : RESULTS_VIEWER_NEEDS_SOURCE,
  };
}

export interface ResultInspectorProps {
  readonly item: ApiWorkspaceItem;
  readonly detail: WorkspaceItemDetailState;
  /** The database is from a newer Fullmag: pins and removals cannot be saved. */
  readonly readOnly: boolean;
  readonly thumbnailUrl?: (id: string) => string;
  /** URL that downloads this folder as a zip; omitted, the download says it needs a backend. */
  readonly archiveUrl?: (id: string) => string;
  readonly onTogglePin: (id: string, pinned: boolean) => Promise<string | null>;
  readonly onForget: (id: string) => void;
  /** Selects the source script or project in the list. */
  readonly onSelectSource: (source: ApiWorkspaceItem) => void;
  /** Opens a project and then its saved results; resolves to a failure message or null. */
  readonly onOpenResults: (project: ApiWorkspaceItem) => Promise<string | null>;
  /** Why opening projects is unavailable right now (no session confirmed); null when it works. */
  readonly openDisabledReason: string | null;
  /** The tab shown first (a deep link, or a test); Overview by default. */
  readonly initialTab?: ResultTab;
}

function resultDetailOf(detail: WorkspaceItemDetailState): ResultDetail | undefined {
  return detail.kind === "ready" && detail.answer.detail?.kind === "result"
    ? detail.answer.detail
    : undefined;
}

/** Why "Download as zip" is off for this folder; null when it can run. */
export function downloadReason(
  item: Pick<ApiWorkspaceItem, "status">,
  archiveUrl: ((id: string) => string) | undefined,
): string | null {
  if (item.status === "missing") return RESULTS_DOWNLOAD_FOLDER_MISSING;
  return archiveUrl ? null : RESULTS_DOWNLOAD_NO_BACKEND;
}

/** What the preview image is, or why there is none; a result is never rendered as an image here. */
export function previewNote(item: ApiWorkspaceItem): string {
  if (!item.hasThumbnail) {
    return "none: the folder holds no image and its source project has no stored preview";
  }
  return item.thumbnailOrigin === "source_project"
    ? "stored preview of the source project, not a render of this result"
    : "stored preview";
}

export function resultFacts(item: ApiWorkspaceItem, result: ResultDetail | undefined): KvRow[][] {
  const total = result?.totalBytes ?? item.sizeBytes;
  const run: KvRow[] = result
    ? [
        ...kvRowOrUnavailable("Run", result.runId),
        ...kvRowOrUnavailable("Status", result.status),
        ...kvRow("Started", result.startedAt ? formatOpened(result.startedAt) : undefined),
        ...kvRow("Finished", result.finishedAt ? formatOpened(result.finishedAt) : undefined),
        ...kvRowOrUnavailable(
          "Format",
          result.format
            ? `${result.format}${result.formatVersion ? ` v${result.formatVersion}` : ""}`
            : undefined,
        ),
      ]
    : [];
  const data: KvRow[] = [
    ...(result ? kvRowOrUnavailable("Grid", result.grid) : []),
    ...(result
      ? kvRowOrUnavailable("Frames", result.frames === undefined ? undefined : result.frames.toLocaleString("en-US"))
      : []),
    ...kvRowOrUnavailable("Size", total === undefined ? undefined : formatBytes(total)),
    ...(result
      ? kvRowOrUnavailable(
          "Quantities",
          result.quantities.length > 0 ? chipList(result.quantities) : undefined,
        )
      : []),
  ];
  const where: KvRow[] = [
    ...kvRow("Preview", previewNote(item)),
    ...kvRow("Modified", item.modifiedAt ? formatOpened(item.modifiedAt) : undefined),
    ...kvRow("First seen", item.firstSeenAt ? formatOpened(item.firstSeenAt) : undefined),
  ];
  return [run, data, where];
}

function SourceLink({
  result,
  linked,
  onSelect,
}: {
  readonly result: ResultDetail | undefined;
  readonly linked: ApiWorkspaceItem | undefined;
  readonly onSelect: (source: ApiWorkspaceItem) => void;
}) {
  const source = result?.source;
  if (!source && !linked) {
    return <p className="fm-start-inspector__note">The folder does not record what produced it.</p>;
  }
  const label = linked?.name ?? source?.path ?? "";
  return (
    <section className="fm-start-kv">
      <h3 className="fm-start-kv__title">Source</h3>
      <dl className="fm-start-kv__grid">
        <div className="fm-start-kv__row">
          <dt>{source?.kind === "project" || linked?.kind === "project" ? "Project" : "Script"}</dt>
          <dd>
            {linked ? (
              <button
                className="fm-start-link"
                data-action="select-source"
                onClick={() => onSelect(linked)}
                title={`Show ${linked.name} in the list`}
                type="button"
              >
                {label}
              </button>
            ) : (
              <span title={source?.path}>{label}</span>
            )}
          </dd>
        </div>
        {!linked ? (
          <div className="fm-start-kv__row">
            <dt>In the list</dt>
            <dd>not indexed</dd>
          </div>
        ) : null}
        {source?.sha256 ? (
          <div className="fm-start-kv__row">
            <dt>Source hash</dt>
            <dd>{source.sha256.slice(0, 12)}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

/**
 * A result folder (.zarr): what produced it, what is in it and how big it is.
 * There is no viewer for a bare folder; "Open results viewer" opens the
 * source project's Results module, and says why when it cannot.
 */
export function ResultInspector({
  item,
  detail,
  readOnly,
  thumbnailUrl,
  archiveUrl,
  onTogglePin,
  onForget,
  onSelectSource,
  onOpenResults,
  openDisabledReason,
  initialTab = "overview",
}: ResultInspectorProps) {
  const baseId = useId();
  const [tab, setTab] = useState<ResultTab>(initialTab);
  const [notice, setNotice] = useState<string | null>(null);
  const invoke = useSyncExternalStore(subscribeNever, tauriInvoke, serverInvoke);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [busy, setBusy] = useState(false);
  const answer = detail.kind === "ready" ? detail.answer : undefined;
  const result = resultDetailOf(detail);
  const missing = item.status === "missing";
  const path = displayPath(item.path);
  const chip = resultChip(item, result?.status);
  const banner = selectResultBanner({
    status: item.status,
    path,
    runStatus: result?.status,
    readError: result?.readError,
  });
  const route = viewerRoute(item, answer);
  const viewerReason = route.reason ?? openDisabledReason;
  const previewSrc = item.hasThumbnail ? thumbnailSource(item, thumbnailUrl) : undefined;
  const source = resultSourceName(item);

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  const report = (text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3200);
  };

  const pin = async () => {
    setBusy(true);
    const failure = await onTogglePin(item.id, !item.pinned);
    setBusy(false);
    if (failure) report(failure);
  };

  const reveal = () => {
    void invoke?.("reveal_in_file_manager", { path: item.path });
  };

  const openViewer = async () => {
    if (!route.project) return;
    setBusy(true);
    const failure = await onOpenResults(route.project);
    setBusy(false);
    if (failure) report(failure);
  };

  const moreActions: MenuAction[] = [
    {
      id: "copy-path",
      label: "Copy path",
      icon: <Copy aria-hidden="true" size={14} />,
      onSelect: () =>
        void copyText(path).then((ok) => report(ok ? "Path copied." : "Could not copy the path to the clipboard.")),
    },
    {
      id: "download-result",
      label: "Download as zip",
      icon: <Download aria-hidden="true" size={14} />,
      onSelect: () => {
        if (archiveUrl) startDownload(archiveUrl(item.id));
      },
      disabledReason: downloadReason(item, archiveUrl),
    },
    {
      id: "reveal-result",
      label: "Reveal in file manager",
      icon: <FolderSearch aria-hidden="true" size={14} />,
      onSelect: reveal,
      disabledReason: missing ? "The folder is missing." : invoke ? null : "Needs the desktop app",
    },
    {
      id: "forget-result",
      label: "Remove from recent",
      icon: <Trash2 aria-hidden="true" size={14} />,
      onSelect: () => onForget(item.id),
      disabledReason: readOnly ? "The workspace database is read-only" : null,
      separatorBefore: true,
    },
  ];

  const splitActions: MenuAction[] = answer?.linkedSource
    ? [
        {
          id: "show-source",
          label: `Show ${answer.linkedSource.kind === "project" ? "source project" : "source script"}`,
          icon: <FileCode2 aria-hidden="true" size={14} />,
          onSelect: () => {
            if (answer.linkedSource) onSelectSource(answer.linkedSource);
          },
        },
      ]
    : [];

  const [runRows, dataRows, whereRows] = resultFacts(item, result);
  const stages = result?.stages ?? [];
  const note =
    detail.kind === "loading"
      ? "Reading the folder…"
      : detail.kind === "error"
        ? `Could not read the folder: ${detail.message}`
        : detail.kind === "ready" && !result
          ? "The backend did not describe this folder's contents."
          : detail.kind === "unavailable" || detail.kind === "idle"
            ? "Stages, quantities and the source are read by a Fullmag backend that serves the workspace database."
            : null;
  const historyRows = scriptHistoryRows(answer?.events ?? []);

  return (
    <aside aria-label="Result details" className="fm-start__inspector fm-start-inspector" data-kind="result">
      <div
        aria-label={previewSrc ? `Preview of ${item.name}` : undefined}
        className="fm-start-preview"
        role={previewSrc ? "img" : undefined}
      >
        <span className="fm-start-preview__label">
          {item.thumbnailOrigin === "source_project" ? "Last result · project preview" : "Last result"}
        </span>
        <ProjectThumb eager size="preview" src={previewSrc} status={missing ? "missing" : "ready"} />
      </div>

      <InspectorHeader
        chips={
          <>
            <span className="fm-start-badge fm-start-badge--script" title="Result folder">
              .zarr
            </span>
            {chip ? (
              <StatusPill label={chip.label || undefined} status={chip.status} title={chip.title || undefined} />
            ) : null}
            {result?.runId ? <span className="fm-start-chip">run {result.runId}</span> : null}
            {source ? <span className="fm-start-chip">{source}</span> : null}
          </>
        }
        moreActions={moreActions}
        name={item.name}
        onCopyFailed={() => report("Could not copy the path to the clipboard.")}
        onTogglePin={() => void pin()}
        path={path}
        pinDisabledReason={readOnly ? "The workspace database is read-only" : null}
        pinned={item.pinned}
      />

      <ContextBanner
        banner={banner}
        onAction={(id) => {
          if (id === "forget") onForget(item.id);
        }}
      />

      <InspectorTabs baseId={baseId} label="Result sections" onChange={setTab} tabs={TABS} value={tab} />

      <InspectorPanel baseId={baseId} tab={tab}>
        {tab === "overview" ? (
          <>
            <KvGroup rows={runRows} title="Run" />
            <SourceLink linked={answer?.linkedSource} onSelect={onSelectSource} result={result} />
            <KvGroup rows={dataRows} title="Data" />
            <KvGroup rows={whereRows} title="Folder" />
            {note ? <p className="fm-start-inspector__note">{note}</p> : null}
          </>
        ) : tab === "stages" ? (
          stages.length > 0 ? (
            <table className="fm-start-formats fm-start-runs">
              <caption className="fm-start-visually-hidden">Stages</caption>
              <thead>
                <tr>
                  <th scope="col">Stage</th>
                  <th scope="col">Steps</th>
                  <th scope="col">Time</th>
                </tr>
              </thead>
              <tbody>
                {stages.map((stage) => (
                  <tr key={stage.id}>
                    <th scope="row">{stageLabel(stage)}</th>
                    <td>{stage.steps === undefined ? "unavailable" : stage.steps.toLocaleString("en-US")}</td>
                    <td>{stage.timeS === undefined ? "unavailable" : formatSimTime(stage.timeS)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="fm-start-inspector__note">
              {result ? "This folder records no stages." : (note ?? "Stages are not available.")}
            </p>
          )
        ) : answer ? (
          historyRows.length === 0 ? (
            <p className="fm-start-inspector__note">Nothing has been recorded for this folder yet.</p>
          ) : (
            <ol className="fm-start-timeline">
              {historyRows.map((row) => (
                <li className={`fm-start-timeline__item fm-start-timeline__item--${row.kind}`} key={row.key}>
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
        ) : (
          <p className="fm-start-inspector__note">{note ?? "The history is not available."}</p>
        )}
      </InspectorPanel>

      <div aria-live="polite" className="fm-start-visually-hidden" role="status">
        {notice ?? ""}
      </div>
      {notice ? (
        <div className="fm-start-banner fm-start-banner--info">
          <div className="fm-start-banner__copy">{notice}</div>
        </div>
      ) : null}

      <InspectorActionBar
        externalDisabledReason={missing ? "The folder is missing." : invoke ? null : "Needs the desktop app"}
        externalLabel="Reveal in file manager"
        onExternal={reveal}
        onPrimary={() => void openViewer()}
        primaryAction="open-results-viewer"
        primaryDisabledReason={viewerReason ?? (busy ? "Another action is running" : null)}
        primaryLabel="Open results viewer"
        splitActions={splitActions}
      />
    </aside>
  );
}
