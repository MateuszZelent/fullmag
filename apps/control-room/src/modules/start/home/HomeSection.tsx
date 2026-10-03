"use client";

import { useSyncExternalStore, type Ref } from "react";

import type { RecentEntry } from "../model/types";

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
  readonly browseDisabledReason: string | null;
  readonly disabledReasons: Readonly<Record<string, string | null>>;
  readonly initialFocusRef?: Ref<HTMLButtonElement>;
  readonly onOpenRecent: (entry: RecentEntry) => Promise<string | null>;
  readonly onRunCommand: (commandId: string) => void;
}

export function HomeSection({
  browseDisabledReason,
  disabledReasons,
  initialFocusRef,
  onOpenRecent,
  onRunCommand,
}: HomeSectionProps) {
  const today = useToday();

  return (
    <>
      <div className="fm-start-page-head">
        <div className="fm-start-page-head__copy">
          <h1>Welcome to Fullmag</h1>
          <p>Start from an empty FDM or FEM problem, or open a project archive.</p>
        </div>
        {today ? <div className="fm-start-page-head__meta">{today}</div> : null}
      </div>
      <LaunchTiles
        disabledReasons={disabledReasons}
        initialFocusRef={initialFocusRef}
        onRunCommand={onRunCommand}
      />
      <RecentProjects
        browseDisabledReason={browseDisabledReason}
        onBrowse={() => onRunCommand("start.browse")}
        onOpen={onOpenRecent}
      />
    </>
  );
}
