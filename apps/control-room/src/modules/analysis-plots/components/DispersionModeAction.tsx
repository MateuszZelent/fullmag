"use client";

import { useState } from "react";
import { Eye } from "lucide-react";
import { createCommandContext } from "@/kernel/commands/commandContext";
import type { SelectionRef } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";
import { Button } from "@/shared/ui/Button";

export interface DispersionModeTarget {
  runId: string | null; stageId: string | null;
  sampleIndex?: number; modeIndex?: number;
  sampleId?: string | null; modeId?: string | null;
}

/** A different Explorer selection must never redirect a chart-point action. */
export function dispersionModeSelectionMatches(ref: SelectionRef | null | undefined, target: DispersionModeTarget): boolean {
  return Boolean(ref?.type === "frequency-domain" && ref.kind === "results.eigen.mode" &&
    target.runId && target.stageId && ref.analysisRunId === target.runId && ref.analysisStageId === target.stageId &&
    target.sampleIndex !== undefined && ref.sampleIndex === target.sampleIndex &&
    target.modeIndex !== undefined && ref.modeIndex === target.modeIndex &&
    (!target.sampleId || ref.sampleId === target.sampleId) && (!target.modeId || ref.modeId === target.modeId));
}

export function DispersionModeAction({ kernel, available, identity, target, onSelectPoint }: {
  kernel: KernelApi; available: boolean; identity: string;
  target: DispersionModeTarget; onSelectPoint: () => void;
}) {
  const [feedback, setFeedback] = useState<{ identity: string; message: string } | null>(null);
  const message = feedback?.identity === identity ? feedback.message : null;
  const ready = available && Boolean(target.runId && target.stageId);
  async function showMode() {
    onSelectPoint();
    if (!dispersionModeSelectionMatches(kernel.selection.get().ref, target)) {
      setFeedback({ identity, message: "The selected chart point could not be bound to the current mode. Select it again." });
      return;
    }
    try {
      const result = await kernel.commands.execute("analysis.eigen.plot-mode-3d",
        createCommandContext("analysis-plots", kernel, { sourceDetail: "dispersion-mode" }),
        { view: "phase_rotated_real", source: "eigen-mode" });
      setFeedback({ identity, message: result.status === "failed" || result.status === "cancelled"
        ? result.message ?? "The selected mode field could not be displayed." : "" });
    } catch {
      setFeedback({ identity, message: "The selected mode field could not be displayed." });
    }
  }
  return <div className="fm-dispersion-mode-action">
    <Button size="sm" variant="primary" disabled={!ready} onClick={() => void showMode()}>
      <Eye size={14} aria-hidden="true" /> View selected mode in 3D
    </Button>
    {!available ? <span>Mode field was not published for this point.</span> : !ready ? <span>Run identity is unavailable. Inspect the selected mode before loading its field.</span> : null}
    {message ? <span role="status">{message}</span> : null}
  </div>;
}
