"use client";

import { FolderOpen, Play, Trash2 } from "lucide-react";

import { Button } from "@/shared/ui/Button";

import { continueLabels, resumeLabel, type ContinueResolution } from "../model/continueModel";
import type { RecentEntry } from "../model/types";
import { ProjectThumb } from "../ui/ProjectThumb";
import { StatusPill } from "../ui/StatusPill";

export interface ContinueCardProps {
  /** What this machine can do with the checkpoint, computed from live truth. */
  readonly resolution: ContinueResolution;
  readonly entry: RecentEntry;
  readonly busy: boolean;
  readonly onResume: (checkpointId: string) => void;
  readonly onOpen: () => void;
  /**
   * Present only when the runtime can delete a checkpoint. Today it cannot, so
   * the caller passes nothing and no Discard button is drawn.
   */
  readonly onDiscard?: () => void;
}

/**
 * The interrupted run, offered first because resuming is the likeliest intent
 * on launch. Never a button that will fail: when this machine cannot resume the
 * checkpoint the primary action is removed and the reason takes the ETA's place;
 * when resuming needs the project to be open it stays visible but disabled,
 * with the reason beside it.
 */
export function ContinueCard({
  resolution,
  entry,
  busy,
  onResume,
  onOpen,
  onDiscard,
}: ContinueCardProps) {
  const { session, resume, reason, status } = resolution;
  const labels = continueLabels(session);
  const resumeEnabled = resume.kind === "enabled";
  return (
    <section
      aria-labelledby="fm-continue-heading"
      className="fm-start-continue"
      data-continue-status={status}
    >
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
          {resumeEnabled ? (
            labels.detail ? (
              <span className="fm-start-continue__detail">{labels.detail}</span>
            ) : null
          ) : (
            <span className="fm-start-continue__reason" id="fm-continue-reason">
              {reason ?? "This checkpoint cannot be resumed by this build."}
            </span>
          )}
        </div>
        <div className="fm-start-continue__actions">
          {resume.kind === "enabled" ? (
            <Button
              disabled={busy}
              onClick={() => onResume(resume.checkpointId)}
              type="button"
              variant="primary"
            >
              <Play aria-hidden="true" size={14} />
              {resumeLabel(status)}
            </Button>
          ) : resume.kind === "disabled" ? (
            <Button
              aria-describedby="fm-continue-reason"
              disabled
              title={resume.reason}
              type="button"
              variant="primary"
            >
              <Play aria-hidden="true" size={14} />
              {resumeLabel(status)}
            </Button>
          ) : null}
          <Button disabled={busy} onClick={onOpen} type="button" variant="secondary">
            <FolderOpen aria-hidden="true" size={14} />
            Open project
          </Button>
          {onDiscard ? (
            <Button disabled={busy} onClick={onDiscard} type="button" variant="ghost">
              <Trash2 aria-hidden="true" size={14} />
              Discard checkpoint
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
