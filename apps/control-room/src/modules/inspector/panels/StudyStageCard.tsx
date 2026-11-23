"use client";

import React from "react";
import { Button } from "@/shared/ui/Button";
import { type StudyStageModel } from "./StudyInspectorPanelModel";
import { StudyProgressBar } from "./StudyProgressBar";

interface StageCardProps {
  active: boolean;
  selected?: boolean;
  stage: StudyStageModel;
  onSelect?: () => void;
}

export function StageCard({
  active,
  selected,
  stage,
  onSelect,
}: StageCardProps) {
  const content = (
    <>
      <div className="fm-study-stage-card__header">
        <span title={stage.label}>{stage.label}</span>
        <small>{stage.status}</small>
      </div>
      <StudyProgressBar
        label={`${stage.label} progress`}
        statusLabel={stage.progressLabel ?? undefined}
        value={stage.progressPercent}
      />
      <div className="fm-study-stage-card__meta">
        {stage.torqueToleranceShortFormatted ? (
          <span>tau {stage.torqueToleranceShortFormatted}</span>
        ) : null}
        {stage.energyTolerance ? <span>E {stage.energyTolerance}</span> : null}
        {stage.maxSteps ? <span>{stage.maxSteps} steps</span> : null}
        {stage.untilSeconds ? <span>{stage.untilSeconds} s</span> : null}
      </div>
    </>
  );

  if (onSelect) {
    return (
      <Button
        className="fm-study-stage-card h-auto w-full items-stretch justify-start"
        aria-current={active ? "step" : undefined}
        data-active={active ? "true" : undefined}
        data-selected={selected ? "true" : undefined}
        data-status={stage.status}
        type="button"
        variant="ghost"
        onClick={onSelect}
      >
        {content}
      </Button>
    );
  }

  return (
    <div
      className="fm-study-stage-card"
      aria-current={active ? "step" : undefined}
      data-active={active ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      data-status={stage.status}
    >
      {content}
    </div>
  );
}
export default StageCard;
