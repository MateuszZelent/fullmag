"use client";

import { useMemo, useState, useSyncExternalStore, type Ref } from "react";

import { homeSubline, resolveContinue } from "../model/continueModel";
import { startSettings } from "../model/startSettings";
import type { ComputeProbeState, RecentEntry } from "../model/types";
import { useContinueLive } from "../model/useContinueLive";
import type { RecentIndexController } from "../model/useRecentIndex";
import type { WorkspaceResultsView, WorkspaceScriptsView } from "../model/workspaceSource";

import { SectionHeader } from "../ui/SectionHeader";

import { ContinueCard } from "./ContinueCard";
import { LaunchTiles } from "./LaunchTiles";
import { RecentProjects } from "./RecentProjects";

const dateFormat = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "long",
  weekday: "long",
  year: "numeric",
});

const subscribeNever = () => () => undefined;

/** The server has no idea of the user's clock or locale, so it renders nothing. */
function useToday(): string {
  return useSyncExternalStore(
    subscribeNever,
    () => dateFormat.format(new Date()),
    () => "",
  );
}

export interface HomeSectionProps {
  readonly recent: RecentIndexController;
  readonly scripts: WorkspaceScriptsView;
  readonly results: WorkspaceResultsView;
  readonly onAddPath: ((path: string) => Promise<string | null>) | null;
  /** Runs the native script picker; the same flow as the palette command. */
  readonly onOpenScript: () => void;
  readonly canOpenScript: boolean;
  readonly scriptFlowNotice?: string | null;
  /** From the host (git config, then the OS user); null keeps the greeting generic. */
  readonly name: string | null;
  readonly browseDisabledReason: string | null;
  readonly disabledReasons: Readonly<Record<string, string | null>>;
  readonly initialFocusRef?: Ref<HTMLButtonElement>;
  readonly onOpenRecent: (entry: RecentEntry) => Promise<string | null>;
  /** Restores the checkpoint into the open session; resolves to a failure message. */
  readonly onResumeContinue: (checkpointId: string, entry: RecentEntry) => Promise<string | null>;
  /** Deletes the checkpoint in the open session's runtime; resolves to a failure message. */
  readonly onDiscardContinue: (checkpointId: string, entry: RecentEntry) => Promise<string | null>;
  readonly compute: ComputeProbeState;
  readonly onRunCommand: (commandId: string) => void;
}

export function HomeSection({
  browseDisabledReason,
  disabledReasons,
  compute,
  initialFocusRef,
  recent,
  scripts,
  results,
  onAddPath,
  onOpenScript,
  canOpenScript,
  scriptFlowNotice = null,
  name,
  onOpenRecent,
  onResumeContinue,
  onDiscardContinue,
  onRunCommand,
}: HomeSectionProps) {
  const today = useToday();
  const [continueBusy, setContinueBusy] = useState(false);
  const [continueError, setContinueError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const live = useContinueLive(compute, restoring);

  const settings = useSyncExternalStore(
    startSettings.subscribe,
    startSettings.getSnapshot,
    startSettings.getServerSnapshot,
  );
  // The summary counts scripts only while the list below shows them.
  const scriptCount =
    settings.recentKind === "all" && scripts.state.kind === "ready" ? scripts.state.items.length : null;

  const index = recent.state.kind === "ready" ? recent.state.index : null;
  const session = index?.continue;
  const continueEntry = session
    ? index?.entries.find((e) => e.projectId === session.projectId)
    : undefined;

  const resolution = useMemo(
    () => (session ? resolveContinue(session, live) : null),
    [session, live],
  );

  const run = async (action: () => Promise<string | null>) => {
    setContinueBusy(true);
    setContinueError(null);
    setContinueError(await action());
    setContinueBusy(false);
  };

  return (
    <>
      <div className="fm-start-page-head">
        <div className="fm-start-page-head__copy">
          <h1>{name ? `Welcome back, ${name}` : "Welcome to Fullmag"}</h1>
          <p>{homeSubline(recent.state, scriptCount)}</p>
        </div>
        {today ? <div className="fm-start-page-head__meta">{today}</div> : null}
      </div>
      {session && resolution && continueEntry ? (
        <section aria-labelledby="fm-start-continue-title" className="fm-start-section">
          <SectionHeader id="fm-start-continue-title" title="Continue where you left off" />
          <ContinueCard
            busy={continueBusy}
            entry={continueEntry}
            onDiscard={(checkpointId) =>
              void run(() => onDiscardContinue(checkpointId, continueEntry))
            }
            onOpen={() => void run(() => onOpenRecent(continueEntry))}
            onResume={(checkpointId) => {
              setRestoring(true);
              void run(() => onResumeContinue(checkpointId, continueEntry)).finally(() =>
                setRestoring(false),
              );
            }}
            resolution={resolution}
          />
          {continueError ? (
            <div className="fm-start-notice fm-start-notice--warning" role="alert">
              {continueError}
            </div>
          ) : null}
        </section>
      ) : null}
      <LaunchTiles
        disabledReasons={disabledReasons}
        initialFocusRef={initialFocusRef}
        onRunCommand={onRunCommand}
      />
      <RecentProjects
        recent={recent}
        scripts={scripts}
        results={results}
        onAddPath={onAddPath}
        browseDisabledReason={browseDisabledReason}
        onBrowse={() => onRunCommand("start.browse")}
        onOpenScript={onOpenScript}
        canOpenScript={canOpenScript}
        scriptFlowNotice={scriptFlowNotice}
        onOpen={onOpenRecent}
      />
    </>
  );
}
