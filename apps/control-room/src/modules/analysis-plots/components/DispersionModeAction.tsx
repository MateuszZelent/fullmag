import { useState } from "react";
import { Eye } from "lucide-react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import type { SelectionRef } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";
import { Button } from "@/shared/ui/Button";

export interface DispersionModeTarget {
  analysisRunId: string | null;
  analysisStageId: string | null;
  artifactPath: string | null;
  artifactRevision: string | null;
  equilibriumId: string | null;
  fieldId: string | null;
  modeId: string | null;
  modeIndex: number | null;
  resourceRef: string | null;
  sampleId: string | null;
  sampleIndex: number | null;
}

/** A chart action can run only against the exact owner and mode it displayed. */
export function dispersionModeSelectionMatches(
  ref: SelectionRef | null | undefined,
  target: DispersionModeTarget,
): boolean {
  if (ref?.type !== "frequency-domain" || ref.kind !== "results.eigen.mode") {
    return false;
  }
  if (!dispersionModeTargetIsComplete(target)) return false;
  return ref.analysisRunId === target.analysisRunId &&
    ref.analysisStageId === target.analysisStageId &&
    ref.artifactPath === target.artifactPath &&
    String(ref.artifactRevision ?? "") === target.artifactRevision &&
    ref.equilibriumId === target.equilibriumId &&
    ref.fieldId === target.fieldId &&
    ref.modeId === target.modeId &&
    ref.modeIndex === target.modeIndex &&
    ref.resourceRef === target.resourceRef &&
    ref.sampleId === target.sampleId &&
    ref.sampleIndex === target.sampleIndex;
}

function dispersionModeTargetIsComplete(target: DispersionModeTarget): boolean {
  return [
    target.analysisRunId,
    target.analysisStageId,
    target.artifactPath,
    target.artifactRevision,
    target.equilibriumId,
    target.fieldId,
    target.modeId,
    target.resourceRef,
    target.sampleId,
  ].every((value) => typeof value === "string" && value.length > 0) &&
    Number.isSafeInteger(target.modeIndex) && (target.modeIndex ?? -1) >= 0 &&
    Number.isSafeInteger(target.sampleIndex) && (target.sampleIndex ?? -1) >= 0;
}

export function DispersionModeAction({
  available,
  kernel,
  onSelectPoint,
  target,
}: {
  available: boolean;
  kernel: KernelApi;
  onSelectPoint: () => void;
  target: DispersionModeTarget;
}) {
  const [feedback, setFeedback] = useState<{ identity: string; message: string } | null>(null);
  const identity = JSON.stringify(target);
  const ready = available && dispersionModeTargetIsComplete(target);
  const message = feedback?.identity === identity ? feedback.message : null;

  async function showSelectedMode() {
    try {
      onSelectPoint();
    } catch {
      setFeedback({
        identity,
        message: "The selected chart point could not be bound to the current mode. Select it again.",
      });
      return;
    }
    if (!dispersionModeSelectionMatches(kernel.selection.get().ref, target)) {
      setFeedback({
        identity,
        message: "The selected chart point could not be bound to the current mode. Select it again.",
      });
      return;
    }
    try {
      const result = await kernel.commands.execute(
        "analysis.eigen.plot-mode-3d",
        createCommandContext("analysis-plots", kernel, { sourceDetail: "dispersion-mode" }),
        { view: "phase_rotated_real", source: "eigen-mode" },
      );
      setFeedback({
        identity,
        message: result.status === "failed" || result.status === "cancelled"
          ? result.message ?? "The selected mode field could not be displayed."
          : "",
      });
    } catch {
      setFeedback({
        identity,
        message: "The selected mode field could not be displayed.",
      });
    }
  }

  const disabledReason = !available
    ? "This point has no published mode field."
    : !ready
      ? "Run, stage, revision, sample, mode, field, or equilibrium identity is unavailable."
      : undefined;

  return (
    <div className="fm-dispersion-mode-action">
      <Button
        disabled={!ready}
        disabledReason={disabledReason}
        onClick={() => void showSelectedMode()}
        size="sm"
        variant="primary"
      >
        <Eye size={14} aria-hidden="true" />
        View selected mode in 3D
      </Button>
      {message ? <span role="status">{message}</span> : null}
    </div>
  );
}
