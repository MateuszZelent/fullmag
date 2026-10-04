"use client";

import { FolderOpen, Play, Trash2 } from "lucide-react";

import { Button } from "@/shared/ui/Button";

import { continueLabels } from "../model/continueModel";
import type { ContinueSession, RecentEntry } from "../model/types";
import { ProjectThumb } from "../ui/ProjectThumb";
import { StatusPill } from "../ui/StatusPill";

export interface ContinueCardProps {
  readonly session: ContinueSession;
  readonly entry: RecentEntry;
  readonly busy: boolean;
  readonly onResume: () => void;
  readonly onOpen: () => void;
  readonly onDiscard: () => void;
}

/**
 * The interrupted run, offered first because resuming is the likeliest intent
 * on launch. Never a button that will fail: when this machine cannot resume the
 * checkpoint the primary action is removed and the reason takes the ETA's place.
 */
export function ContinueCard({
  session,
  entry,
  busy,
  onResume,
  onOpen,
  onDiscard,
}: ContinueCardProps) {
  const labels = continueLabels(session);
  return (
    <section aria-labelledby="fm-continue-heading" className="fm-start-continue">
      <ProjectThumb size="continue" src={entry.thumbnail} status={entry.status} />
      <div className="fm-start-continue__body">
        <h3 className="fm-start-continue__name" id="fm-continue-heading">
          {entry.name}
        </h3>
        <p className="fm-start-continue__path" title={entry.path}>
          {entry.path}
        </p>
        <div className="fm-start-continue__progress">
          <StatusPill label={labels.timeLabel} status="running" />
          <div
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={labels.percent}
            aria-valuetext={labels.valueText}
            className="fm-start-bar"
            role="progressbar"
          >
            <div className="fm-start-bar__fill" style={{ width: `${labels.percent}%` }} />
          </div>
          <span className="fm-start-continue__pct">{labels.percent}%</span>
          {session.resumable ? (
            labels.detail ? (
              <span className="fm-start-continue__detail">{labels.detail}</span>
            ) : null
          ) : (
            <span className="fm-start-continue__reason">
              {session.notResumableReason ?? "This checkpoint cannot be resumed by this build."}
            </span>
          )}
        </div>
        <div className="fm-start-continue__actions">
          {session.resumable ? (
            <Button disabled={busy} onClick={onResume} type="button" variant="primary">
              <Play aria-hidden="true" size={14} />
              Resume run
            </Button>
          ) : null}
          <Button disabled={busy} onClick={onOpen} type="button" variant="secondary">
            <FolderOpen aria-hidden="true" size={14} />
            Open project
          </Button>
          <Button disabled={busy} onClick={onDiscard} type="button" variant="ghost">
            <Trash2 aria-hidden="true" size={14} />
            Discard checkpoint
          </Button>
        </div>
      </div>
    </section>
  );
}
