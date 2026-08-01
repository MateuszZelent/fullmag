"use client";

import React from "react";
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
        <span>{stage.label}</span>
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
      <button
        className="fm-study-stage-card"
        data-active={active ? "true" : undefined}
        data-selected={selected ? "true" : undefined}
        data-status={stage.status}
        type="button"
        onClick={onSelect}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      className="fm-study-stage-card"
      data-active={active ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      data-status={stage.status}
    >
      {content}
    </div>
  );
}
export default StageCard;
