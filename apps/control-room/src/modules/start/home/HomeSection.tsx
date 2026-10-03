"use client";

import { useState, useSyncExternalStore, type Ref } from "react";

import { homeSubline } from "../model/continueModel";
import type { ContinueSession, RecentEntry } from "../model/types";
import type { RecentIndexController } from "../model/useRecentIndex";

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
  /** From the host (git config, then the OS user); null keeps the greeting generic. */
  readonly name: string | null;
  readonly browseDisabledReason: string | null;
  readonly disabledReasons: Readonly<Record<string, string | null>>;
  readonly initialFocusRef?: Ref<HTMLButtonElement>;
  readonly onOpenRecent: (entry: RecentEntry) => Promise<string | null>;
  readonly onResumeContinue: (session: ContinueSession, entry: RecentEntry) => Promise<string | null>;
  readonly onDiscardContinue: (session: ContinueSession) => Promise<string | null>;
  readonly onRunCommand: (commandId: string) => void;
}

export function HomeSection({
  browseDisabledReason,
  disabledReasons,
  initialFocusRef,
  recent,
  name,
  onOpenRecent,
  onResumeContinue,
  onDiscardContinue,
  onRunCommand,
}: HomeSectionProps) {
  const today = useToday();
  const [continueBusy, setContinueBusy] = useState(false);
  const [continueError, setContinueError] = useState<string | null>(null);

  const index = recent.state.kind === "ready" ? recent.state.index : null;
  const session = index?.continue;
  const continueEntry = session
    ? index?.entries.find((e) => e.projectId === session.projectId)
    : undefined;

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
          <p>{homeSubline(recent.state)}</p>
        </div>
        {today ? <div className="fm-start-page-head__meta">{today}</div> : null}
      </div>
      {session && continueEntry ? (
        <section aria-labelledby="fm-start-continue-title" className="fm-start-section">
          <SectionHeader id="fm-start-continue-title" title="Continue where you left off" />
          <ContinueCard
            busy={continueBusy}
            entry={continueEntry}
            onDiscard={() => {
              if (window.confirm(`Delete the checkpoint of ${continueEntry.name}? The project is kept.`)) {
                void run(() => onDiscardContinue(session));
              }
            }}
            onOpen={() => void run(() => onOpenRecent(continueEntry))}
            onResume={() => void run(() => onResumeContinue(session, continueEntry))}
            session={session}
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
        browseDisabledReason={browseDisabledReason}
        onBrowse={() => onRunCommand("start.browse")}
        onOpen={onOpenRecent}
      />
    </>
  );
}
