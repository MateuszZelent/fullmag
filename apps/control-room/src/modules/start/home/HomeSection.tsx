"use client";

import { FolderOpen } from "lucide-react";
import { useSyncExternalStore, type Ref } from "react";

import { Button } from "@/shared/ui/Button";

import { SectionHeader } from "../ui/SectionHeader";

import { LaunchTiles } from "./LaunchTiles";

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
  readonly onRunCommand: (commandId: string) => void;
}

export function HomeSection({
  browseDisabledReason,
  disabledReasons,
  initialFocusRef,
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
      <section aria-labelledby="fm-start-recent-title" className="fm-start-section">
        <SectionHeader id="fm-start-recent-title" title="Recent projects" />
        <div className="fm-start-list-foot">
          <Button
            aria-keyshortcuts="Control+O"
            data-command-id="start.browse"
            disabled={browseDisabledReason !== null}
            onClick={() => onRunCommand("start.browse")}
            size="sm"
            title={browseDisabledReason ?? "Open a project archive (Ctrl+O)"}
            type="button"
            variant="secondary"
          >
            <FolderOpen aria-hidden="true" size={14} />
            Browse…
          </Button>
          <span className="fm-start-list-foot__note">
            {browseDisabledReason ?? "The recent-project index is not available in this build."}
          </span>
        </div>
      </section>
    </>
  );
}
