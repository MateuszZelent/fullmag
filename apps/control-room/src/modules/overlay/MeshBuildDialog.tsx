"use client";

import { useEffect, useReducer, type CSSProperties } from "react";

import {
  useMeshBuildCurrent,
  useMeshBuildLatestSuccessful,
  useMeshSharedDomainManifestResource,
  useMeshSummaryResource,
} from "@/kernel/resources/geometryLifecycleResources";
import type { KernelApi } from "@/kernel/types";
import {
  normalizeMeshPipelineStatus,
  resolveMeshBuildStatusLabel,
  type MeshPipelinePhase,
} from "@/shared/domain/mesh/buildPipeline";
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, fallback = "unknown"): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function commandIsMeshBuild(commandId: string): boolean {
  return commandId === "mesh.build-selected" || commandId === "mesh.build-shared-domain";
}

function phaseIsComplete(phase: MeshPipelinePhase): boolean {
  const status = phase.status.toLowerCase();
  return (
    status === "done" ||
    status === "ready" ||
    status === "completed" ||
    status === "success"
  );
}

function pipelineProgressPercent(phases: readonly MeshPipelinePhase[]): number | null {
  if (phases.length === 0) return null;
  const completeCount = phases.filter(phaseIsComplete).length;
  return Math.round((completeCount / phases.length) * 100);
}

export function MeshBuildPipelineView({
  buildReport,
  lastSummary,
  phases,
}: {
  buildReport: unknown;
  lastSummary: Record<string, unknown> | null;
  phases: readonly MeshPipelinePhase[];
}) {
  const buildReportRecord = asRecord(buildReport);
  const buildMode = text(buildReportRecord?.build_mode, "unknown");
  const lastElementCount = text(
    lastSummary?.elements ?? lastSummary?.element_count,
    "unknown",
  );
  const progressPercent = pipelineProgressPercent(phases);

  return (
    <section className="fm-dialog__mesh-pipeline" aria-label="Mesh build pipeline">
      <div className="fm-dialog__mesh-pipeline-header">
        <h3 className="fm-dialog__mesh-pipeline-title">Build pipeline</h3>
        <span className="fm-dialog__mesh-pipeline-meta">{buildMode}</span>
      </div>
      {progressPercent !== null ? (
        <div
          className="fm-dialog__mesh-progress"
          style={
            {
              "--fm-mesh-build-progress": `${progressPercent}%`,
            } as CSSProperties
          }
        >
          <span>Phase progress</span>
          <strong>{progressPercent}%</strong>
        </div>
      ) : null}
      {phases.length > 0 ? (
        <ol className="fm-dialog__mesh-phase-list">
          {phases.map((phase) => (
            <li className="fm-dialog__mesh-phase" key={phase.id}>
              <span className="fm-dialog__mesh-phase-label">{phase.label}</span>
              <span className="fm-dialog__mesh-phase-status">{phase.status}</span>
              {phase.detail.length > 0 ? (
                <span className="fm-dialog__mesh-phase-detail">{phase.detail}</span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="fm-dialog__mesh-pipeline-empty">
          No active build phases are published.
        </p>
      )}
      <dl className="fm-dialog__mesh-pipeline-summary">
        <div className="fm-dialog__details-row">
          <dt className="fm-dialog__details-label">Build mode</dt>
          <dd className="fm-dialog__details-value">{buildMode}</dd>
        </div>
        <div className="fm-dialog__details-row">
          <dt className="fm-dialog__details-label">Last elements</dt>
          <dd className="fm-dialog__details-value">{lastElementCount}</dd>
        </div>
      </dl>
    </section>
  );
}

interface MeshBuildDialogState {
  lastCommandId: string | null;
  lastCommandStatus: string;
  open: boolean;
}

type MeshBuildDialogAction =
  | {
      commandId: string;
      status: string;
      type: "command";
    }
  | {
      open: boolean;
      type: "open";
    };

function meshBuildDialogReducer(
  state: MeshBuildDialogState,
  action: MeshBuildDialogAction,
): MeshBuildDialogState {
  if (action.type === "open") {
    return { ...state, open: action.open };
  }
  return {
    lastCommandId: action.commandId,
    lastCommandStatus: action.status,
    open: true,
  };
}

export function MeshBuildDialog({ kernel }: { kernel: KernelApi }) {
  const [state, dispatch] = useReducer(meshBuildDialogReducer, {
    lastCommandId: null,
    lastCommandStatus: "pending",
    open: false,
  });
  const activeBuild = useMeshBuildCurrent();
  const latestBuild = useMeshBuildLatestSuccessful();
  const summary = useMeshSummaryResource();
  const manifest = useMeshSharedDomainManifestResource();
  const activeRecord = asRecord(activeBuild.data?.active_build);
  const pipelinePhases = normalizeMeshPipelineStatus(activeBuild.data?.mesh_pipeline_status);
  const lastSummary = asRecord(
    activeBuild.data?.last_build_summary ?? latestBuild.data?.last_success,
  );
  const buildReport = activeBuild.data?.shared_domain_build_report;
  const buildStatus = resolveMeshBuildStatusLabel(activeRecord, pipelinePhases);

  useEffect(() => {
    const offSubmitted = kernel.bus.on("command:submitted", ({ commandId }) => {
      if (!commandIsMeshBuild(commandId)) return;
      dispatch({ commandId, status: "submitted", type: "command" });
    });
    const offCompleted = kernel.bus.on("command:completed", ({ commandId, status }) => {
      if (!commandIsMeshBuild(commandId)) return;
      dispatch({ commandId, status, type: "command" });
    });
    return () => {
      offSubmitted();
      offCompleted();
    };
  }, [kernel.bus]);

  return (
    <Dialog
      open={state.open}
      onOpenChange={(open) => dispatch({ open, type: "open" })}
    >
      <DialogContent aria-describedby="fm-mesh-build-dialog-description">
        <DialogHeader>
          <DialogTitle>Mesh Build</DialogTitle>
          <DialogDescription id="fm-mesh-build-dialog-description">
            Backend v2 command status, current build resource, and last successful mesh.
          </DialogDescription>
        </DialogHeader>
        <div className="fm-dialog__body">
          <dl className="fm-dialog__details">
            <div className="fm-dialog__details-row">
              <dt className="fm-dialog__details-label">Command</dt>
              <dd className="fm-dialog__details-value">{state.lastCommandId ?? "none"}</dd>
            </div>
            <div className="fm-dialog__details-row">
              <dt className="fm-dialog__details-label">Command state</dt>
              <dd className="fm-dialog__details-value">{state.lastCommandStatus}</dd>
            </div>
            <div className="fm-dialog__details-row">
              <dt className="fm-dialog__details-label">Build resource</dt>
              <dd className="fm-dialog__details-value">{activeBuild.status}</dd>
            </div>
            <div className="fm-dialog__details-row">
              <dt className="fm-dialog__details-label">Active build</dt>
              <dd className="fm-dialog__details-value">
                {buildStatus}
              </dd>
            </div>
            <div className="fm-dialog__details-row">
              <dt className="fm-dialog__details-label">Mesh</dt>
              <dd className="fm-dialog__details-value">
                {manifest.data?.mesh_name ?? "not built"}
              </dd>
            </div>
            <div className="fm-dialog__details-row">
              <dt className="fm-dialog__details-label">Revision</dt>
              <dd className="fm-dialog__details-value">
                {summary.data?.revision ?? activeBuild.data?.revision ?? "unknown"}
              </dd>
            </div>
            <div className="fm-dialog__details-row">
              <dt className="fm-dialog__details-label">Last error</dt>
              <dd className="fm-dialog__details-value">
                {activeBuild.data?.last_build_error ??
                  latestBuild.data?.last_build_error ??
                  "none"}
              </dd>
            </div>
          </dl>

          <MeshBuildPipelineView
            buildReport={buildReport}
            lastSummary={lastSummary}
            phases={pipelinePhases}
          />
        </div>
        <DialogFooter>
          <Button
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => dispatch({ open: false, type: "open" })}
          >
            Keep Running
          </Button>
          <DialogClose asChild>
            <Button size="sm" type="button" variant="primary">
              Close
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
