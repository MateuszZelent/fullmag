"use client";

import { Compass } from "lucide-react";
import { useState } from "react";

import { ScratchAuthoringGuide } from "@/kernel/authoring/ScratchAuthoringGuide";
import { resolveScratchAuthoringAction } from "@/kernel/authoring/scratchAuthoringGuideModel";
import { toChecklist } from "@/kernel/authoring/scratchAuthoringReadiness";
import type { CommandContext } from "@/kernel/commands/commandTypes";
import { useModelReadinessResource } from "@/kernel/resources/studyRuntimeResources";
import type { KernelApi } from "@/kernel/types";
import { FemMeshReadinessGuideCard } from "@/modules/inspector/public";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";

export function ReadinessHelperHeaderControl({
  commandContext,
  kernel,
}: {
  readonly commandContext: CommandContext;
  readonly kernel: KernelApi;
}) {
  const [open, setOpen] = useState(false);
  const readiness = useModelReadinessResource({ enabled: true });
  const checks = readiness.data ? toChecklist(readiness.data) : [];
  const incompleteChecks = checks.filter((check) => check.state !== "complete");
  const incompleteCount = incompleteChecks.length;
  const firstIncomplete = incompleteChecks[0] ?? null;
  const nextAction = firstIncomplete
    ? resolveScratchAuthoringAction(firstIncomplete)
    : null;

  const isReady = Boolean(readiness.data?.ready_to_run && incompleteCount === 0);
  const helperStatus: "attention" | "loading" | "ready" = isReady
    ? "ready"
    : readiness.data
      ? "attention"
      : "loading";

  const badgeText = isReady
    ? "Ready"
    : nextAction
      ? `${nextAction.label} (${incompleteCount})`
      : incompleteCount > 0
        ? `${incompleteCount} steps`
        : "Guide";

  const buttonTitle = isReady
    ? "Simulation & Mesh Helper: Model is ready to run. Click to open readiness & FEM mesh guide."
    : nextAction
      ? `Simulation & Mesh Helper: Next recommended step — ${nextAction.label} (${incompleteCount} remaining). Click to open guide.`
      : "Open Simulation & FEM Mesh Readiness Helper";

  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Simulation and Mesh Readiness Helper"
        className="fm-header__helper-trigger"
        data-helper-status={helperStatus}
        data-testid="header-readiness-helper-trigger"
        title={buttonTitle}
        type="button"
        onClick={() => setOpen(true)}
      >
        <span
          aria-hidden="true"
          className="fm-header__helper-dot"
          data-status={helperStatus}
        />
        <Compass aria-hidden="true" className="fm-header__helper-icon" size={13} />
        <span className="fm-header__helper-label">Helper</span>
        <span className="fm-header__helper-badge">{badgeText}</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          aria-describedby="fm-readiness-helper-dialog-description"
          aria-label="Simulation and FEM Mesh Readiness Helper"
          className="fm-helper-modal"
        >
          <DialogHeader>
            <DialogTitle>Simulation &amp; FEM Mesh Readiness Helper</DialogTitle>
            <DialogDescription id="fm-readiness-helper-dialog-description">
              Interactive assistant showing what still needs to be configured before
              building the FEM mesh and running the study.
            </DialogDescription>
          </DialogHeader>
          <div className="fm-dialog__body fm-helper-modal__body">
            {open ? (
              <>
                <ScratchAuthoringGuide
                  commandContext={commandContext}
                  kernel={kernel}
                  readiness={readiness}
                  onCloseModal={() => setOpen(false)}
                />
                <FemMeshReadinessGuideCard onNavigate={() => setOpen(false)} />
              </>
            ) : null}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button size="sm" type="button" variant="secondary">
                Close
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
