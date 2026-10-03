"use client";

import { Copy, FolderSearch, Star } from "lucide-react";
import { useId, useState, useSyncExternalStore, type KeyboardEvent } from "react";

import { tauriInvoke } from "@/kernel/persistence/ProjectDocumentController";
import { Button } from "@/shared/ui/Button";

import { openLabel, selectBanner } from "../model/bannerModel";
import { readProvenance, type ProvenanceState } from "../model/provenance";
import type { ContinueSession, InspectorTab, RecentEntry } from "../model/types";
import { ProjectThumb } from "../ui/ProjectThumb";
import { SolverBadge } from "../ui/SolverBadge";
import { StatusPill } from "../ui/StatusPill";

import { ContextBanner } from "./ContextBanner";
import { InspectorOverview } from "./InspectorOverview";
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
      return "Authors, history and runs are read by the desktop app.";
    case "error":
      return `Could not read the project record: ${state.message}`;
    case "ready":
      return "";
  }
}

export interface ProjectDetailsProps {
  readonly entry: RecentEntry;
  readonly session?: ContinueSession;
  readonly openDisabledReason: string | null;
  /** Resolves to the reason the project did not open, or null on success. */
  readonly onOpen: (entry: RecentEntry) => Promise<string | null>;
  readonly onTogglePin: (projectId: string, pinned: boolean) => void;
  readonly onForget: (projectId: string) => void;
}

export function ProjectDetails({
  entry,
  session,
  openDisabledReason,
  onOpen,
  onTogglePin,
  onForget,
}: ProjectDetailsProps) {
  const [tab, setTab] = useState<InspectorTab>("overview");
  const [copied, setCopied] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [provenance, setProvenance] = useState<ProvenanceState>({ kind: "idle" });
  const baseId = useId();
  const banner = selectBanner({ entry, session });
  const missing = entry.status === "missing";
  // Hydration starts with the same disabled desktop action as server rendering.
  // The fixed host bridge becomes available in React's client snapshot phase.
  const invoke = useSyncExternalStore(subscribeNever, tauriInvoke, serverInvoke);

  // Provenance is read from the archive only when a tab that needs it opens.
  const selectTab = (next: InspectorTab) => {
    setTab(next);
    if (next !== "overview" && provenance.kind === "idle") {
      setProvenance({ kind: "loading" });
      void readProvenance(entry.path).then(setProvenance);
    }
  };

  const copyPath = () => {
    void navigator.clipboard?.writeText(entry.path).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % TABS.length
        : event.key === "ArrowLeft"
          ? (index + TABS.length - 1) % TABS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? TABS.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    const target = TABS[next];
    if (!target) return;
    selectTab(target.id);
    document.getElementById(`${baseId}-tab-${target.id}`)?.focus();
  };

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

      <header className="fm-start-inspector__head">
        <div className="fm-start-inspector__title-row">
          <h2 className="fm-start-inspector__name">{entry.name}</h2>
          <Button
            aria-label={entry.pinned ? `Unpin ${entry.name}` : `Pin ${entry.name}`}
            aria-pressed={entry.pinned ?? false}
            onClick={() => onTogglePin(entry.projectId, !entry.pinned)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Star aria-hidden="true" fill={entry.pinned ? "currentColor" : "none"} size={14} />
          </Button>
        </div>
        <div className="fm-start-inspector__path">
          <span title={entry.path}>{entry.path}</span>
          <Button
            aria-label={copied ? "Path copied" : "Copy path"}
            onClick={copyPath}
            size="icon"
            title="Copy path"
            type="button"
            variant="ghost"
          >
            <Copy aria-hidden="true" size={12} />
          </Button>
        </div>
        <div className="fm-start-chips">
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
        </div>
      </header>

      <ContextBanner
        banner={banner}
        onAction={(id) => {
          if (id === "forget") onForget(entry.projectId);
        }}
      />

      <div aria-label="Project sections" className="fm-start-tabs" role="tablist">
        {TABS.map((item, index) => (
          <button
            aria-controls={`${baseId}-panel`}
            aria-selected={tab === item.id}
            className="fm-start-tab"
            id={`${baseId}-tab-${item.id}`}
            key={item.id}
            onClick={() => selectTab(item.id)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
            role="tab"
            tabIndex={tab === item.id ? 0 : -1}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>

      <div
        aria-labelledby={`${baseId}-tab-${tab}`}
        className="fm-start-inspector__body"
        id={`${baseId}-panel`}
        role="tabpanel"
      >
        {tab === "overview" ? (
          <InspectorOverview summary={entry.summary} />
        ) : provenance.kind === "ready" ? (
          tab === "authors" ? (
            <AuthorsPanel entry={entry} provenance={provenance.provenance} />
          ) : tab === "history" ? (
            <HistoryPanel provenance={provenance.provenance} />
          ) : (
            <RunsPanel provenance={provenance.provenance} />
          )
        ) : (
          <p className="fm-start-inspector__note">{provenanceNote(provenance)}</p>
        )}
      </div>

      {openError ? (
        <div className="fm-start-banner fm-start-banner--danger" role="alert">
          <div className="fm-start-banner__copy">{openError}</div>
        </div>
      ) : null}

      <footer className="fm-start-inspector__foot">
        <Button
          className="fm-start-inspector__open"
          disabled={missing || openDisabledReason !== null}
          onClick={() => {
            setOpenError(null);
            void onOpen(entry).then(setOpenError);
          }}
          title={missing ? "The file is missing." : (openDisabledReason ?? undefined)}
          type="button"
          variant="primary"
        >
          {openLabel(entry)}
        </Button>
        <Button
          aria-label="Reveal in file manager"
          disabled={!invoke || missing}
          onClick={() => void invoke?.("reveal_in_file_manager", { path: entry.path })}
          size="icon"
          title={invoke ? "Reveal in file manager" : "Needs the desktop app"}
          type="button"
          variant="secondary"
        >
          <FolderSearch aria-hidden="true" size={14} />
        </Button>
      </footer>
    </aside>
  );
}
