"use client";

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

import type { SimulationPreparationViewModel } from "./simulationPreparationModel";

interface SimulationPreparationFailureDialogProps {
  readonly copyState: "copied" | "failed" | "idle";
  readonly diagnosticReport: string;
  readonly onCopy: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onOpenDiagnostics: () => void;
  readonly open: boolean;
  readonly state: SimulationPreparationViewModel;
}

export function SimulationPreparationFailureDialog({
  copyState,
  diagnosticReport,
  onCopy,
  onOpenChange,
  onOpenDiagnostics,
  open,
  state,
}: SimulationPreparationFailureDialogProps) {
  const failure = state.failure;
  const snapshot = state.preparation;
  if (!failure || !snapshot) return null;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        aria-describedby="fm-simulation-preparation-failure-description"
        className="fm-simulation-preparation-failure-dialog"
      >
        <DialogHeader>
          <DialogTitle>Simulation preparation failed</DialogTitle>
          <DialogDescription id="fm-simulation-preparation-failure-description">
            {failure.summary}
          </DialogDescription>
        </DialogHeader>

        <div className="fm-dialog__body">
          <p className="fm-dialog__error">
            {failure.detail ??
              "The runtime did not expose an additional safe error detail."}
          </p>
          <p aria-live="polite" className="fm-visually-hidden" role="status">
            {copyState === "copied"
              ? "Diagnostic report copied to clipboard."
              : copyState === "failed"
                ? "Could not copy diagnostic report. Try again."
                : ""}
          </p>
          <dl className="fm-dialog__details">
            <div className="fm-dialog__details-row">
              <dt className="fm-dialog__details-label">Stage</dt>
              <dd className="fm-dialog__details-value">{failure.stageLabel}</dd>
            </div>
            <div className="fm-dialog__details-row">
              <dt>Stage duration</dt>
              <dd>{failure.stageElapsedLabel}</dd>
            </div>
            <div className="fm-dialog__details-row">
              <dt>Error code</dt>
              <dd><code>{failure.errorCode}</code></dd>
            </div>
            <div className="fm-dialog__details-row">
              <dt>Diagnostic ID</dt>
              <dd><code>{failure.correlationId ?? "Unavailable"}</code></dd>
            </div>
            <div className="fm-dialog__details-row">
              <dt>Preparation</dt>
              <dd><code>{snapshot.preparation_id}</code> · revision {snapshot.revision}</dd>
            </div>
            <div className="fm-dialog__details-row">
              <dt>Requested execution</dt>
              <dd>{state.requestedExecutionLabel ?? "Unavailable"}</dd>
            </div>
            <div className="fm-dialog__details-row">
              <dt>Resolved execution</dt>
              <dd>{state.resolvedExecutionLabel ?? "Unavailable"}</dd>
            </div>
          </dl>
          <pre className="fm-dialog__details fm-simulation-preparation-failure-dialog__report">
            {diagnosticReport}
          </pre>
        </div>

        <DialogFooter>
          <Button onClick={onCopy} size="sm" type="button">
            {copyState === "copied"
              ? "Copy again"
              : copyState === "failed"
                ? "Retry copy"
                : "Copy diagnostic report"}
          </Button>
          <Button
            onClick={onOpenDiagnostics}
            size="sm"
            type="button"
            variant="primary"
          >
            Open full diagnostics
          </Button>
          <DialogClose asChild>
            <Button size="sm" type="button">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

