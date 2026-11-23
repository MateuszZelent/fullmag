"use client";

import { Copy, Download, FileCode2, FolderSearch, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { Button } from "@/shared/ui/Button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/shared/ui/Tooltip";
import { tauriInvoke } from "@/kernel/persistence/ProjectDocumentController";

import { selectResultBanner } from "../model/bannerModel";
import { startDownload } from "../model/downloadUrl";
import { formatSimTime } from "../model/continueModel";
import { formatOpened } from "../model/recentIndex";
import { resultChip, resultSourceName, stageLabel } from "../model/resultModel";
import { scriptHistoryRows } from "../model/scriptEvents";
import { copyText, displayPath } from "../model/scriptRowModel";
import type { WorkspaceItemDetailState } from "../model/useWorkspaceItems";
import { thumbnailSource } from "../model/workspaceApiAdapters";
import type { ApiWorkspaceItem, ResultDetail } from "../model/workspaceApiTypes";
import { type FramesPage } from "../model/framesModel";
import { ProjectThumb } from "../ui/ProjectThumb";
import { StatusPill } from "../ui/StatusPill";

import { ContextBanner } from "./ContextBanner";
import { FrameScrubber } from "./FrameScrubber";
import {
  InspectorActionBar,
  InspectorHeader,
  InspectorPanel,
  InspectorTabs,
  type MenuAction,
} from "./InspectorParts";
import { KvGroup } from "./KeyValueGroup";
import { viewerRoute, downloadReason, resultFacts } from "./ResultInspector.model";
import { StartInspectorTemplateFrame } from "./StartScreenInspectorSpecs";

export type ResultTab = "overview" | "stages" | "history";

const TABS: readonly { readonly id: ResultTab; readonly label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "stages", label: "Stages" },
  { id: "history", label: "History" },
];

const subscribeNever = () => () => undefined;
const serverInvoke = () => null;

export interface ResultInspectorProps {
  readonly item: ApiWorkspaceItem;
  readonly detail: WorkspaceItemDetailState;
  /** The database is from a newer Fullmag: pins and removals cannot be saved. */
  readonly readOnly: boolean;
  readonly thumbnailUrl?: (id: string) => string;
  /** URL that downloads this folder as a zip; omitted, the download says it needs a backend. */
  readonly archiveUrl?: (id: string) => string;
  /** Reads a page of the saved-frame index; omitted, the scrubber is not offered. */
  readonly loadFrames?: (id: string, from: number, limit: number) => Promise<FramesPage>;
  readonly onTogglePin: (id: string, pinned: boolean) => Promise<string | null>;
  readonly onForget: (id: string) => void;
  /** Selects the source script or project in the list. */
  readonly onSelectSource: (source: ApiWorkspaceItem) => void;
  /** Opens a project and then its saved results; resolves to a failure message or null. */
  readonly onOpenResults: (project: ApiWorkspaceItem) => Promise<string | null>;
  /** Opens this result folder directly in read-only playback when available. */
  readonly onOpenPlayback?: (item: ApiWorkspaceItem) => Promise<string | null>;
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
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label={`Show ${linked.name} in the list`}
                    className="fm-start-link"
                    data-action="select-source"
                    onClick={() => onSelect(linked)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {label}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{`Show ${linked.name} in the list`}</TooltipContent>
              </Tooltip>
            ) : source?.path ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>{label}</span>
                </TooltipTrigger>
                <TooltipContent>{source.path}</TooltipContent>
              </Tooltip>
            ) : (
              <span>{label}</span>
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
  loadFrames,
  onTogglePin,
  onForget,
  onSelectSource,
  onOpenResults,
  onOpenPlayback,
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
  const viewerReason = onOpenPlayback
    ? (missing ? "The folder is missing." : null)
    : route.reason ?? openDisabledReason;
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
    try {
      const failure = await onTogglePin(item.id, !item.pinned);
      if (failure) report(failure);
    } catch (error) {
      report(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const reveal = () => {
    void invoke?.("reveal_in_file_manager", { path: item.path });
  };

  const openViewer = async () => {
    const project = route.project;
    const open = onOpenPlayback
      ? missing ? null : () => onOpenPlayback(item)
      : project ? () => onOpenResults(project) : null;
    if (!open) return;
    setBusy(true);
    try {
      const failure = await open();
      if (failure) report(failure);
    } catch (error) {
      report(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
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
    <StartInspectorTemplateFrame
      ariaLabel="Result details"
      breadcrumbs={["Start", "Results", item.name]}
      customIdentity={
        <InspectorHeader
          chips={
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="fm-start-badge fm-start-badge--script">.zarr</span>
                </TooltipTrigger>
                <TooltipContent>Result folder</TooltipContent>
              </Tooltip>
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
      }
      dataKind="result"
      footer={
        <InspectorActionBar
          externalDisabledReason={missing ? "The folder is missing." : invoke ? null : "Needs the desktop app"}
          externalLabel="Reveal in file manager"
          onExternal={reveal}
          onPrimary={() => void openViewer()}
          primaryAction="open-results-viewer"
          primaryDisabledReason={viewerReason ?? (busy ? "Another action is running" : null)}
          primaryLabel={onOpenPlayback ? "Open saved playback" : "Open results viewer"}
          splitActions={splitActions}
        />
      }
      modeTabs={
        <InspectorTabs baseId={baseId} label="Result sections" onChange={setTab} tabs={TABS} value={tab} />
      }
      notices={
        banner ? (
          <ContextBanner
            banner={banner}
            onAction={(id) => {
              if (id === "forget") onForget(item.id);
            }}
          />
        ) : undefined
      }
      preview={
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
      }
      specId="start.result"
      title={item.name}
      typeLabel="Result archive"
    >
      <InspectorPanel baseId={baseId} tab={tab}>
        {tab === "overview" ? (
          <>
            <KvGroup rows={runRows} title="Run" />
            <SourceLink linked={answer?.linkedSource} onSelect={onSelectSource} result={result} />
            <KvGroup rows={dataRows} title="Data" />
            {result?.framesIndex && loadFrames ? (
              <FrameScrubber
                itemId={item.id}
                key={item.id}
                loadPage={loadFrames}
                stageName={(id) => {
                  const stage = stages.find((entry) => entry.id === id);
                  return stage ? stageLabel(stage) : id;
                }}
                summary={result.framesIndex}
              />
            ) : result && result.frames ? (
              <p className="fm-start-inspector__note">
                {result.framesIndex
                  ? "The frame index is available from a Fullmag backend that serves the workspace database."
                  : `${result.frames.toLocaleString("en-US")} frames are saved, but this folder has no frame index (it was written before the index existed), so their steps and times are not listed.`}
              </p>
            ) : null}
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
    </StartInspectorTemplateFrame>
  );
}
