"use client";

import { CheckCircle2, Loader2, AlertTriangle, X, Minimize2, GitCommitHorizontal, Layers, Triangle } from "lucide-react";

import type { EngineLogEntry, MeshWorkspaceState } from "@/lib/session/types";
import { Button } from "../../ui/button";
import { cn } from "@/lib/utils";
import BackendErrorNotice from "./BackendErrorNotice";
import { fmtSI } from "./shared";
import type { EffectiveMeshTarget, MeshBuildDialogIntent, MeshBuildStage } from "./meshWorkspace";
import type { BackendErrorInfo } from "./types";

interface MeshBuildModalProps {
  open: boolean;
  generating: boolean;
  intent: MeshBuildDialogIntent | null;
  stages: MeshBuildStage[];
  progressValue: number;
  engineLog: EngineLogEntry[];
  meshWorkspace: MeshWorkspaceState | null;
  effectiveTargets: EffectiveMeshTarget[];
  errorMessage?: string | null;
  errorDetails?: BackendErrorInfo | null;
  onClose: () => void;
  onBackground: () => void;
}

function stageIcon(status: MeshBuildStage["status"]) {
  switch (status) {
    case "done":
      return <CheckCircle2 size={15} className="text-success" />;
    case "warning":
      return <AlertTriangle size={15} className="text-warning" />;
    case "active":
      return <Loader2 size={15} className="animate-spin text-primary" />;
    default:
      return <span className="h-2.5 w-2.5 rounded-full border border-border/70 bg-background/70" />;
  }
}

function formatLogTime(timestampUnixMs: number): string {
  if (!Number.isFinite(timestampUnixMs)) {
    return "—";
  }
  return new Date(timestampUnixMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function operationStatusesFromSummary(summary: Record<string, unknown> | null): Array<{
  kind: string;
  scope: string;
  status: string;
  requestedMethod: string | null;
  actualMethod: string | null;
  reason: string | null;
}> {
  const raw = Array.isArray(summary?.operation_statuses) ? summary.operation_statuses : [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const kind = textOrNull(record.kind);
    const status = textOrNull(record.status);
    if (!kind || !status) return [];
    return [{
      kind,
      scope: textOrNull(record.scope) ?? "global",
      status,
      requestedMethod: textOrNull(record.requested_method),
      actualMethod: textOrNull(record.actual_method),
      reason: textOrNull(record.reason),
    }];
  });
}

function operationStatusClass(status: string): string {
  switch (status.toLowerCase()) {
    case "applied":
      return "border-emerald-400/20 bg-emerald-400/10 text-emerald-200";
    case "fallback":
      return "border-amber-400/25 bg-amber-400/10 text-amber-200";
    case "failed":
      return "border-red-400/25 bg-red-400/10 text-red-200";
    default:
      return "border-white/10 bg-white/[0.04] text-slate-300";
  }
}

export default function MeshBuildModal({
  open,
  generating,
  intent,
  stages,
  progressValue,
  engineLog,
  meshWorkspace,
  effectiveTargets,
  errorMessage = null,
  errorDetails = null,
  onClose,
  onBackground,
}: MeshBuildModalProps) {
  if (!open || !intent) {
    return null;
  }

  const buildSummary = meshWorkspace?.last_build_summary ?? null;
  const structuredTargets = meshWorkspace?.effective_per_object_targets ?? null;
  const effectiveAirboxTarget = meshWorkspace?.effective_airbox_target ?? null;
  const effectiveErrorMessage = errorMessage ?? meshWorkspace?.last_build_error ?? null;
  const hasError = Boolean(effectiveErrorMessage || errorDetails);
  const meshSummary = meshWorkspace?.mesh_summary ?? null;
  const summaryBuildMode =
    buildSummary && typeof buildSummary.shared_domain_build_mode === "string"
      ? buildSummary.shared_domain_build_mode
      : null;
  const summaryFieldKinds =
    buildSummary && Array.isArray(buildSummary.used_size_field_kinds)
      ? buildSummary.used_size_field_kinds.filter((entry): entry is string => typeof entry === "string")
      : [];
  const summaryFallbacks =
    buildSummary && Array.isArray(buildSummary.fallbacks_triggered)
      ? buildSummary.fallbacks_triggered.filter((entry): entry is string => typeof entry === "string")
      : [];
  const operationStatuses = operationStatusesFromSummary(buildSummary);
  const recentHistory = meshWorkspace?.mesh_history?.slice().reverse().slice(0, 4) ?? [];
  const modalLog = engineLog
    .filter((entry) => {
      const lower = entry.message.toLowerCase();
      return (
        lower.includes("mesh") ||
        lower.includes("remesh") ||
        lower.includes("gmsh") ||
        lower.includes("script_sync") ||
        lower.includes("shared-domain") ||
        lower.includes("stl") ||
        lower.includes("tetra")
      );
    })
    .slice(-16)
    .reverse();
  const fallbackTimestamp = engineLog.at(-1)?.timestamp_unix_ms ?? 0;

  return (
    <div className="fixed inset-0 z-[160] flex items-center justify-center bg-black/60 px-6 py-8 backdrop-blur-sm">
      <div className="relative flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[linear-gradient(180deg,rgba(18,24,38,0.96),rgba(9,12,20,0.98))] shadow-[0_24px_120px_rgba(0,0,0,0.55)]">
        <div className="border-b border-white/8 px-6 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[0.65rem] font-semibold uppercase tracking-[0.22em] text-cyan-300/75">
                Mesh Build
              </div>
              <div className="mt-1 text-xl font-semibold text-white">
                {intent.title}: {intent.targetLabel}
              </div>
              {intent.contextLabel ? (
                <div className="mt-1 text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-slate-400">
                  Context: {intent.contextLabel}
                </div>
              ) : null}
              <div className="mt-1 text-sm text-slate-300/75">
                One shared-domain FEM mesh is rebuilt from the current object overrides, shared object defaults and airbox settings. The viewport keeps showing the last built mesh until this rebuild finishes.
              </div>
            </div>
            <div className="flex items-center gap-2">
              {generating ? (
                <Button type="button" variant="outline" size="sm" onClick={onBackground}>
                  <Minimize2 className="h-4 w-4" />
                  Run in background
                </Button>
              ) : (
                <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close mesh build dialog">
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
          <div className="mt-4">
            <div className="flex items-center justify-between text-[0.68rem] uppercase tracking-[0.18em] text-slate-400">
              <span>{generating ? "Building mesh" : hasError ? "Build failed" : "Build finished"}</span>
              <span>{Math.round(progressValue)}%</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/8">
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-300",
                  hasError ? "bg-warning" : "bg-info",
                )}
                style={{ width: `${Math.max(4, Math.min(100, progressValue))}%` }}
              />
            </div>
            {hasError ? (
              <BackendErrorNotice
                  error={
                    errorDetails ?? {
                    timestampUnixMs: fallbackTimestamp,
                    level: "error",
                    title: "Operation interrupted by backend error",
                    summary: effectiveErrorMessage ?? "Mesh build failed",
                    details: effectiveErrorMessage ?? "Mesh build failed",
                    traceback: null,
                  }
                }
                compact
                className="mt-3"
              />
            ) : null}
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[1.2fr_1fr] gap-0">
          <div className="flex min-h-0 flex-col border-r border-white/8">
            <div className="grid grid-cols-3 gap-3 px-6 py-4">
              <div className="rounded-xl border border-white/8 bg-white/[0.03] px-3 py-3">
                <div className="flex items-center gap-2 text-[0.65rem] uppercase tracking-[0.16em] text-slate-400">
                  <GitCommitHorizontal size={13} />
                  Nodes
                </div>
                <div className="mt-2 font-mono text-lg text-white">
                  {meshSummary?.node_count?.toLocaleString() ?? "—"}
                </div>
              </div>
              <div className="rounded-xl border border-white/8 bg-white/[0.03] px-3 py-3">
                <div className="flex items-center gap-2 text-[0.65rem] uppercase tracking-[0.16em] text-slate-400">
                  <Triangle size={13} />
                  Elements
                </div>
                <div className="mt-2 font-mono text-lg text-white">
                  {meshSummary?.element_count?.toLocaleString() ?? "—"}
                </div>
              </div>
              <div className="rounded-xl border border-white/8 bg-white/[0.03] px-3 py-3">
                <div className="flex items-center gap-2 text-[0.65rem] uppercase tracking-[0.16em] text-slate-400">
                  <Layers size={13} />
                  Boundary faces
                </div>
                <div className="mt-2 font-mono text-lg text-white">
                  {meshSummary?.boundary_face_count?.toLocaleString() ?? "—"}
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
              <div className="text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Pipeline stages
              </div>
              <div className="mt-3 grid gap-2">
                {stages.map((stage) => (
                  <div
                    key={stage.id}
                    className={cn(
                      "rounded-xl border px-3 py-3 transition-colors",
                      stage.status === "done"
                        ? "border-emerald-500/20 bg-emerald-500/10"
                        : stage.status === "active"
                          ? "border-cyan-400/30 bg-cyan-400/10"
                          : stage.status === "warning"
                            ? "border-amber-500/25 bg-amber-500/10"
                            : "border-white/8 bg-white/[0.03]",
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        {stageIcon(stage.status)}
                        <span className="text-sm font-medium text-white">{stage.label}</span>
                      </div>
                      <span className="text-[0.65rem] uppercase tracking-[0.16em] text-slate-400">
                        {stage.status}
                      </span>
                    </div>
                    <div className="mt-1.5 text-sm leading-relaxed text-slate-300/78">
                      {stage.detail ?? "—"}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="grid min-h-0 grid-rows-[auto_auto_auto_1fr]">
            <div className="border-b border-white/8 px-6 py-4">
              <div className="text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Effective mesh targets
              </div>
              <div className="mt-3 grid gap-2">
                {structuredTargets && Object.keys(structuredTargets).length > 0 ? Object.entries(structuredTargets).map(([geometryName, target]) => (
                  <div key={geometryName} className="rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate font-mono text-sm text-white">{geometryName}</span>
                      <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[0.6rem] uppercase tracking-[0.14em] text-slate-400">
                        {target.source ?? "backend"}
                      </span>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-[0.72rem] text-slate-300/78">
                      <span>Bulk maximum element size</span>
                      <span className="text-right font-mono text-white">
                        {target.hmax != null ? fmtSI(target.hmax, "m") : "auto"}
                      </span>
                      <span>Interface maximum element size</span>
                      <span className="text-right font-mono text-white">
                        {target.interface_hmax != null ? fmtSI(target.interface_hmax, "m") : "—"}
                      </span>
                      <span>Edge maximum element size</span>
                      <span className="text-right font-mono text-white">
                        {target.edge_hmax != null ? fmtSI(target.edge_hmax, "m") : "—"}
                      </span>
                      <span>Edge thickness</span>
                      <span className="text-right font-mono text-white">
                        {target.edge_thickness != null ? fmtSI(target.edge_thickness, "m") : "—"}
                      </span>
                      <span>Corner maximum element size</span>
                      <span className="text-right font-mono text-white">
                        {target.corner_hmax != null ? fmtSI(target.corner_hmax, "m") : "—"}
                      </span>
                      <span>Corner extent</span>
                      <span className="text-right font-mono text-white">
                        {target.corner_extent != null ? fmtSI(target.corner_extent, "m") : "—"}
                      </span>
                    </div>
                  </div>
                )) : effectiveTargets.length > 0 ? effectiveTargets.map((target) => (
                  <div key={target.geometryName} className="rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate font-mono text-sm text-white">{target.geometryName}</span>
                      <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[0.6rem] uppercase tracking-[0.14em] text-slate-400">
                        {target.source === "local_override" ? "local override" : "study default"}
                      </span>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-[0.72rem] text-slate-300/78">
                      <span>Max element size</span>
                      <span className="text-right font-mono text-white">
                        {target.hmax != null ? fmtSI(target.hmax, "m") : "auto"}
                      </span>
                      <span>Min element size</span>
                      <span className="text-right font-mono text-white">
                        {target.hmin != null ? fmtSI(target.hmin, "m") : "auto"}
                      </span>
                    </div>
                  </div>
                )) : (
                  <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-3 py-3 text-sm text-slate-400">
                    No object-specific mesh targets are available yet.
                  </div>
                )}
              </div>
            </div>

            <div className="border-b border-white/8 px-6 py-4">
              <div className="text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Last built mesh summary
              </div>
              <div className="mt-2 grid gap-1.5 text-sm leading-relaxed text-slate-300/80">
                <div>
                  {meshSummary
                    ? `${meshSummary.mesh_name} · ${meshSummary.source_kind} · maximum element size ${fmtSI(meshSummary.hmax, "m")}`
                    : "Mesh summary will appear here as soon as the first build finishes."}
                </div>
                {summaryBuildMode ? (
                  <div>Build mode: <span className="font-mono text-white">{summaryBuildMode}</span></div>
                ) : null}
                {effectiveAirboxTarget?.hmax != null ? (
                  <div>Airbox maximum element size: <span className="font-mono text-white">{fmtSI(effectiveAirboxTarget.hmax, "m")}</span></div>
                ) : null}
                {summaryFieldKinds.length > 0 ? (
                  <div>Size fields: <span className="font-mono text-white">{summaryFieldKinds.join(", ")}</span></div>
                ) : null}
                {summaryFallbacks.length > 0 ? (
                  <div>Fallbacks: <span className="font-mono text-amber-300">{summaryFallbacks.join(", ")}</span></div>
                ) : null}
                {operationStatuses.length > 0 ? (
                  <div className="mt-3 grid gap-2">
                    <div className="text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-slate-500">
                      Operation statuses
                    </div>
                    {operationStatuses.map((operation, index) => (
                      <div
                        key={`${operation.kind}:${operation.scope}:${index}`}
                        className={cn("rounded-lg border px-2.5 py-2", operationStatusClass(operation.status))}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="truncate font-mono text-[0.72rem]">
                            {operation.kind}.{operation.scope}
                          </span>
                          <span className="text-[0.58rem] font-bold uppercase tracking-[0.14em]">
                            {operation.status}
                          </span>
                        </div>
                        <div className="mt-1 font-mono text-[0.68rem] opacity-90">
                          {operation.requestedMethod ?? "auto"} → {operation.actualMethod ?? "none"}
                        </div>
                        {operation.reason ? (
                          <div className="mt-1 text-[0.68rem] leading-relaxed opacity-85">
                            {operation.reason}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="border-b border-white/8 px-6 py-4">
              <div className="text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Recent builds
              </div>
              <div className="mt-3 grid gap-2">
                {recentHistory.length > 0 ? recentHistory.map((entry, index) => (
                  <div key={`${entry.mesh_name}-${entry.node_count}-${index}`} className="rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2.5 text-[0.74rem] text-slate-300/80">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate font-mono text-sm text-white">
                        {entry.mesh_name || "mesh"}
                      </span>
                      <span className="text-[0.62rem] uppercase tracking-[0.14em] text-slate-400">
                        {entry.generation_mode ?? entry.kind ?? "manual"}
                      </span>
                    </div>
                    <div className="mt-1">
                      {entry.node_count.toLocaleString()} nodes · {entry.element_count.toLocaleString()} tetra · {entry.boundary_face_count.toLocaleString()} faces
                    </div>
                  </div>
                )) : (
                  <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-3 py-3 text-sm text-slate-400">
                    Build history will appear here after the first completed remesh.
                  </div>
                )}
              </div>
            </div>

            <div className="min-h-0 overflow-y-auto px-6 py-4">
              <div className="text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Backend log
              </div>
              <div className="mt-3 grid gap-2">
                {modalLog.length > 0 ? modalLog.map((entry, index) => (
                  <div key={`${entry.timestamp_unix_ms}-${index}`} className="rounded-xl border border-white/8 bg-black/25 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[0.62rem] uppercase tracking-[0.16em] text-slate-500">
                        {entry.level}
                      </span>
                      <span className="font-mono text-[0.68rem] text-slate-500">
                        {formatLogTime(entry.timestamp_unix_ms)}
                      </span>
                    </div>
                    <div className="mt-1 text-sm leading-relaxed text-slate-200/85">
                      {entry.message}
                    </div>
                  </div>
                )) : (
                  <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-3 py-3 text-sm text-slate-400">
                    Waiting for mesh-related log messages from the backend.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
