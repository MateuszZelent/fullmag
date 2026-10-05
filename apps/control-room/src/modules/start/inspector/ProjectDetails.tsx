"use client";

import { BarChart3, Copy, FolderSearch, Trash2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { tauriInvoke } from "@/kernel/persistence/ProjectDocumentController";

import { openLabel, selectBanner } from "../model/bannerModel";
import { readProvenance, type ProvenanceState } from "../model/provenance";
import { copyText } from "../model/scriptRowModel";
import type { ContinueSession, InspectorTab, RecentEntry } from "../model/types";
import type { WorkspaceItemDetailState } from "../model/useWorkspaceItems";
import {
  applyProjectDetail,
  detailToModelSummary,
  detailToProvenance,
} from "../model/workspaceApiAdapters";
import type { ApiWorkspaceItem, ProjectDetail } from "../model/workspaceApiTypes";
import { ProjectThumb } from "../ui/ProjectThumb";
import { SolverBadge } from "../ui/SolverBadge";
import { StatusPill } from "../ui/StatusPill";

import { ContextBanner } from "./ContextBanner";
import { InspectorOverview } from "./InspectorOverview";
import {
  InspectorActionBar,
  InspectorHeader,
  InspectorPanel,
  InspectorTabs,
  type MenuAction,
} from "./InspectorParts";
import { AuthorsPanel, HistoryPanel, RunsPanel } from "./ProvenancePanels";

const TABS: readonly { readonly id: InspectorTab; readonly label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "authors", label: "Authors" },
  { id: "history", label: "History" },
  { id: "runs", label: "Runs" },
];

const subscribeNever = () => () => undefined;
const serverInvoke = () => null;

function provenanceNote(state: ProvenanceState): string {
  switch (state.kind) {
    case "loading":
    case "idle":
      return "Reading the project…";
    case "unavailable":
      return "Authors, history and runs are read by the desktop app or a Fullmag backend that serves the workspace database.";
    case "error":
      return `Could not read the project record: ${state.message}`;
    case "ready":
      return "";
  }
}

function projectDetailOf(detail: WorkspaceItemDetailState): ProjectDetail | undefined {
  return detail.kind === "ready" && detail.answer.detail?.kind === "project"
    ? detail.answer.detail
    : undefined;
}

export interface ProjectDetailsProps {
  readonly entry: RecentEntry;
  readonly session?: ContinueSession;
  readonly openDisabledReason: string | null;
  /** What the HTTP workspace API read from the file; idle without it. */
  readonly detail?: WorkspaceItemDetailState;
  /** Resolves to the reason the project did not open, or null on success. */
  readonly onOpen: (entry: RecentEntry) => Promise<string | null>;
  /** Opens the project and shows its saved results; resolves like `onOpen`. */
  readonly onOpenResults?: (entry: RecentEntry) => Promise<string | null>;
  readonly onTogglePin: (projectId: string, pinned: boolean) => void;
  readonly onForget: (projectId: string) => void;
  /** Selects a result folder in the list (a row of the Runs tab). */
  readonly onSelectResult?: (id: string) => void;
  /** The tab shown first (a deep link, or a test); Overview by default. */
  readonly initialTab?: InspectorTab;
}

const IDLE: WorkspaceItemDetailState = { kind: "idle" };

export function ProjectDetails({
  entry: listedEntry,
  session,
  openDisabledReason,
  detail = IDLE,
  onOpen,
  onOpenResults,
  onTogglePin,
  onForget,
  onSelectResult,
  initialTab = "overview",
}: ProjectDetailsProps) {
  const [tab, setTab] = useState<InspectorTab>(initialTab);
  const [openError, setOpenError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [desktopProvenance, setDesktopProvenance] = useState<ProvenanceState>({ kind: "idle" });
  const baseId = useId();
  const project = projectDetailOf(detail);
  // The facts only the read file knows refine the index's hint.
  const entry = useMemo(() => applyProjectDetail(listedEntry, project), [listedEntry, project]);
  const banner = selectBanner({
    entry,
    session,
    migrationSteps: project?.warnings,
    readError: project?.readError,
  });
  const missing = entry.status === "missing";
  // Hydration starts with the same disabled desktop action as server rendering.
  // The fixed host bridge becomes available in React's client snapshot phase.
  const invoke = useSyncExternalStore(subscribeNever, tauriInvoke, serverInvoke);

  // The backend answers authors, history and runs with the detail; the desktop
  // reads them from the archive only when a tab that needs them opens.
  const backendRead = project !== undefined && !project.readError;
  const viaBackend = detail.kind === "loading" || backendRead;
  const provenance: ProvenanceState = useMemo(() => {
    if (detail.kind === "loading") return { kind: "loading" };
    if (project && backendRead) {
      return { kind: "ready", provenance: detailToProvenance(project) };
    }
    return desktopProvenance;
  }, [detail.kind, project, backendRead, desktopProvenance]);

  // The archive is read only once a tab that needs it is open and the backend
  // has not (or cannot) answer; the read settles into state, never a throw.
  const desktopReadStarted = useRef(false);
  const needDesktopRead = tab !== "overview" && !viaBackend;
  useEffect(() => {
    if (!needDesktopRead || desktopReadStarted.current) return;
    desktopReadStarted.current = true;
    void readProvenance(entry.path).then(setDesktopProvenance);
  }, [needDesktopRead, entry.path]);

  const linkedResults: readonly ApiWorkspaceItem[] =
    detail.kind === "ready" ? detail.answer.linkedResults : [];
  const summary = project ? (detailToModelSummary(project) ?? entry.summary) : entry.summary;

  const reveal = () => void invoke?.("reveal_in_file_manager", { path: entry.path });
  const open = () => {
    setOpenError(null);
    void onOpen(entry).then(setOpenError);
  };
  const openResults = onOpenResults
    ? () => {
        setOpenError(null);
        void onOpenResults(entry).then(setOpenError);
      }
    : undefined;
  const revealReason = missing ? "The file is missing." : invoke ? null : "Needs the desktop app";
  const resultsReason = missing ? "The file is missing." : openDisabledReason;

  const moreActions: MenuAction[] = [
    {
      id: "copy-path",
      label: "Copy path",
      icon: <Copy aria-hidden="true" size={14} />,
      onSelect: () =>
        void copyText(entry.path).then((ok) =>
          setNotice(ok ? "Path copied." : "Could not copy the path to the clipboard."),
        ),
    },
    {
      id: "reveal-project",
      label: "Reveal in file manager",
      icon: <FolderSearch aria-hidden="true" size={14} />,
      onSelect: reveal,
      disabledReason: revealReason,
    },
    {
      id: "forget-project",
      label: "Remove from recent",
      icon: <Trash2 aria-hidden="true" size={14} />,
      onSelect: () => onForget(entry.projectId),
      separatorBefore: true,
    },
  ];
  const splitActions: MenuAction[] = openResults
    ? [
        {
          id: "open-results",
          label: "Open results viewer",
          icon: <BarChart3 aria-hidden="true" size={14} />,
          onSelect: openResults,
          disabledReason: resultsReason,
        },
      ]
    : [];

  return (
    <aside aria-label="Project details" className="fm-start__inspector fm-start-inspector">
      <div
        aria-label={entry.thumbnail ? `Last result of ${entry.name}` : undefined}
        className="fm-start-preview"
        role={entry.thumbnail ? "img" : undefined}
      >
        <span className="fm-start-preview__label">Last result</span>
        <ProjectThumb eager size="preview" src={entry.thumbnail} status={entry.status} />
      </div>

      <InspectorHeader
        chips={
          <>
            <SolverBadge solver={entry.solver} />
            <StatusPill status={entry.status} />
            {entry.revision !== undefined ? (
              <span className="fm-start-chip">rev {entry.revision}</span>
            ) : null}
            {entry.manifestSchemaVersion ? (
              <span className="fm-start-chip">schema {entry.manifestSchemaVersion}</span>
            ) : null}
            {entry.tags?.map((tag) => (
              <span className="fm-start-chip" key={tag}>
                #{tag}
              </span>
            ))}
          </>
        }
        moreActions={moreActions}
        name={entry.name}
        onCopyFailed={() => setNotice("Could not copy the path to the clipboard.")}
        onTogglePin={() => onTogglePin(entry.projectId, !entry.pinned)}
        path={entry.path}
        pinned={entry.pinned ?? false}
      />

      <ContextBanner
        banner={banner}
        onAction={(id) => {
          if (id === "forget") onForget(entry.projectId);
        }}
      />

      <InspectorTabs baseId={baseId} label="Project sections" onChange={setTab} tabs={TABS} value={tab} />

      <InspectorPanel baseId={baseId} tab={tab}>
        {tab === "overview" ? (
          <>
            <InspectorOverview listEveryField={project?.summary !== undefined} summary={summary} />
            {detail.kind === "loading" ? (
              <p className="fm-start-inspector__note">Reading the project…</p>
            ) : null}
          </>
        ) : provenance.kind === "ready" ? (
          tab === "authors" ? (
            <AuthorsPanel entry={entry} provenance={provenance.provenance} />
          ) : tab === "history" ? (
            <HistoryPanel provenance={provenance.provenance} />
          ) : (
            <RunsPanel
              linkedResults={linkedResults}
              onSelectResult={onSelectResult}
              provenance={provenance.provenance}
              viewer={openResults ? { disabledReason: resultsReason, onOpen: openResults } : undefined}
            />
          )
        ) : (
          <p className="fm-start-inspector__note">{provenanceNote(provenance)}</p>
        )}
      </InspectorPanel>

      <div aria-live="polite" className="fm-start-visually-hidden" role="status">
        {notice ?? ""}
      </div>
      {openError ? (
        <div className="fm-start-banner fm-start-banner--danger" role="alert">
          <div className="fm-start-banner__copy">{openError}</div>
        </div>
      ) : null}

      <InspectorActionBar
        externalDisabledReason={revealReason}
        externalLabel="Reveal in file manager"
        onExternal={reveal}
        onPrimary={open}
        primaryAction="open-project"
        primaryDisabledReason={missing ? "The file is missing." : openDisabledReason}
        primaryLabel={openLabel(entry)}
        splitActions={splitActions}
      />
    </aside>
  );
}
