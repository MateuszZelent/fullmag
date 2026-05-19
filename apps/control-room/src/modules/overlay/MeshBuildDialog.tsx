"use client";

import { useEffect, useReducer, type CSSProperties } from "react";

import {
  useMeshBuildCurrent,
  useMeshBuildLatestSuccessful,
  useMeshSharedDomainManifestResource,
  useMeshSummaryResource,
} from "@/kernel/resources/geometryLifecycleResources";
import {
  shouldLoadRuntimeMeshBuild,
  shouldLoadRuntimeMeshManifest,
  shouldLoadRuntimeMeshSummary,
  useEngineLogResource,
} from "@/kernel/resources/studyRuntimeResources";
import { useSessionStatus } from "@/kernel/resources/useSessionStatus";
import type { EngineLogResource } from "@/kernel/api/apiTypes";
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
  const publishedProgress = phases.find(
    (phase) => phase.progressPercent !== null,
  )?.progressPercent;
  if (publishedProgress !== undefined && publishedProgress !== null) {
    return publishedProgress;
  }
  const completeCount = phases.filter(phaseIsComplete).length;
  return Math.round((completeCount / phases.length) * 100);
}

function formatDurationMs(value: number | null): string | null {
  if (value === null) return null;
  if (value < 1000) return `${value} ms`;
  const seconds = value / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds).toString()} s`;
}

type EngineLogEntry = EngineLogResource["entries"][number];
type MeshDiagnosticNavigation = {
  readonly bus: {
    emit: (
      event: "footer:tab-requested",
      payload: { reason?: string; tab: "engine" | "logs" | "telemetry" },
    ) => void;
  };
  readonly layout: Pick<KernelApi["layout"], "setFocusedSlot" | "setPanelVisible">;
};

export function openMeshBuildDiagnostics(kernel: MeshDiagnosticNavigation) {
  kernel.layout.setPanelVisible("bottom", true);
  kernel.layout.setFocusedSlot("panel-bottom");
  kernel.bus.emit("footer:tab-requested", {
    reason: "mesh-build",
    tab: "engine",
  });
}

function isMeshBuildLogEntry(entry: EngineLogEntry): boolean {
  const message = entry.message.toLowerCase();
  return (
    message.includes("gmsh") ||
    message.includes("mesh build") ||
    message.includes("meshing") ||
    message.includes("remesh")
  );
}

function formatLogTime(timestampUnixMs: number): string {
  return new Date(timestampUnixMs).toISOString().slice(11, 19);
}

export function MeshBuildLogView({
  entries,
  status,
  total,
}: {
  entries: readonly EngineLogEntry[];
  status: string;
  total: number;
}) {
  const meshEntries = entries.filter(isMeshBuildLogEntry).slice(-8).reverse();

  return (
    <section className="fm-dialog__mesh-log" aria-label="Mesh build console">
      <div className="fm-dialog__mesh-log-header">
        <h3 className="fm-dialog__mesh-log-title">Build console</h3>
        <span className="fm-dialog__mesh-log-meta">
          {meshEntries.length} / {total} entries
        </span>
      </div>
      {meshEntries.length > 0 ? (
        <div className="fm-dialog__mesh-log-list" role="table">
          {meshEntries.map((entry) => (
            <div
              className="fm-dialog__mesh-log-row"
              role="row"
              key={`${entry.timestamp_unix_ms}:${entry.level}:${entry.message}`}
            >
              <time role="cell">{formatLogTime(entry.timestamp_unix_ms)}</time>
              <span role="cell" data-level={entry.level}>
                {entry.level}
              </span>
              <span role="cell">{entry.message}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="fm-dialog__mesh-log-empty">
          {status === "ready" ? "No mesh build log entries." : "Loading mesh build logs."}
        </p>
      )}
    </section>
  );
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
  const progressPhase = phases.find((phase) => phase.progressPercent !== null);
  const progressLabel = progressPhase?.progressLabel ?? "Phase progress";

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
          <span>{progressLabel}</span>
          <strong>{progressPercent}%</strong>
        </div>
      ) : null}
      {phases.length > 0 ? (
        <ol className="fm-dialog__mesh-phase-list">
          {phases.map((phase) => {
            const duration = formatDurationMs(phase.durationMs);
            const progressText =
              phase.progressPercent !== null
                ? `${phase.progressLabel ?? "Gmsh progress"} - ${phase.progressPercent}%`
                : null;
            const timingText = duration ? `duration ${duration}` : null;
            const progressDetail = [progressText, timingText].filter(Boolean).join(" / ");
            return (
              <li className="fm-dialog__mesh-phase" key={phase.id}>
                <span className="fm-dialog__mesh-phase-label">{phase.label}</span>
                <span className="fm-dialog__mesh-phase-status">{phase.status}</span>
                {progressDetail.length > 0 ? (
                  <span className="fm-dialog__mesh-phase-progress">{progressDetail}</span>
                ) : null}
                {phase.detail.length > 0 ? (
                  <span className="fm-dialog__mesh-phase-detail">{phase.detail}</span>
                ) : null}
              </li>
            );
          })}
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
  const sessionStatus = useSessionStatus();
  const activeBuild = useMeshBuildCurrent({
    enabled: shouldLoadRuntimeMeshBuild(state.open, sessionStatus.data),
  });
  const latestBuild = useMeshBuildLatestSuccessful({
    enabled: shouldLoadRuntimeMeshBuild(state.open, sessionStatus.data),
  });
  const summary = useMeshSummaryResource({
    enabled: shouldLoadRuntimeMeshSummary(state.open, sessionStatus.data),
  });
  const manifest = useMeshSharedDomainManifestResource({
    enabled: shouldLoadRuntimeMeshManifest(state.open, sessionStatus.data),
  });
  const engineLog = useEngineLogResource({ enabled: state.open });
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
          <MeshBuildLogView
            entries={engineLog.data?.entries ?? []}
            status={engineLog.status}
            total={engineLog.data?.total ?? 0}
          />
        </div>
        <DialogFooter>
          <Button
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => openMeshBuildDiagnostics(kernel)}
          >
            Open diagnostics
          </Button>
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
