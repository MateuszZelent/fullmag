"use client";

import { Info } from "lucide-react";
import { useEffect } from "react";

import type { SolverStatusResource } from "@/kernel/api/apiTypes";
import {
  useCommandDetailResource,
  useModelReadinessResource,
} from "@/kernel/resources/studyRuntimeResources";
import type {
  ActiveLaneCapabilitySnapshot,
} from "@/kernel/resources/useActiveLaneCapabilities";
import { CommandDetailDialog } from "@/shared/runtime/CommandDetailDialog";
import { Button } from "@/shared/ui/Button";

import type { StudyInspectorModel } from "../../panels/StudyInspectorPanelModel";
import { StudyProgressBar } from "../../panels/StudyProgressBar";
export function ConnectedReadinessBridge({
  onReadiness,
}: {
  onReadiness: (data: Record<string, unknown> | null) => void;
}) {
  const readiness = useModelReadinessResource();
  useEffect(() => {
    onReadiness((readiness.data ?? null) as Record<string, unknown> | null);
  }, [onReadiness, readiness.data]);
  return null;
}

export function ConnectedCommandDetailModal({
  commandId,
  onClose,
}: {
  commandId: string;
  onClose: () => void;
}) {
  const detail = useCommandDetailResource(commandId);
  return (
    <CommandDetailDialog
      commandId={commandId}
      detail={detail}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    />
  );
}

export function StudyRootRuntimeTelemetryCard({
  activeLane,
  onSelectCommandId,
  runtimeModel,
  solverStatus,
}: {
  activeLane: ActiveLaneCapabilitySnapshot | null;
  onSelectCommandId: (commandId: string | null) => void;
  runtimeModel: StudyInspectorModel;
  solverStatus: SolverStatusResource | null;
}) {
                      const rawSimTime =
                        typeof solverStatus?.sim_time_seconds === "number" &&
                        Number.isFinite(solverStatus.sim_time_seconds)
                          ? solverStatus.sim_time_seconds
                          : typeof solverStatus?.pseudo_time_seconds === "number" &&
                              Number.isFinite(solverStatus.pseudo_time_seconds)
                            ? solverStatus.pseudo_time_seconds
                            : null;
                      const simTimeVal =
                        rawSimTime !== null
                          ? `${rawSimTime.toExponential(3)} s`
                          : "—";
                      const stepVal =
                        typeof solverStatus?.step_index === "number" &&
                        Number.isFinite(solverStatus.step_index)
                          ? String(solverStatus.step_index)
                          : "—";
                      const maxTorqueVal =
                        !runtimeModel.runtime.maxTorque ||
                        runtimeModel.runtime.maxTorque === "unavailable"
                          ? "—"
                          : runtimeModel.runtime.maxTorque;
                      const maxRhsNormVal =
                        !runtimeModel.runtime.maxRhsNorm ||
                        runtimeModel.runtime.maxRhsNorm === "unavailable"
                          ? "—"
                          : runtimeModel.runtime.maxRhsNorm;
                      const relaxStopVal = runtimeModel.runtime.relaxTorqueStop
                        ? `${
                            runtimeModel.runtime.relaxTorqueStop.current ===
                            "unavailable"
                              ? "—"
                              : runtimeModel.runtime.relaxTorqueStop.current
                          } / ${runtimeModel.runtime.relaxTorqueStop.threshold}`
                        : "—";
                      return (
                        <div className="grid gap-2 text-xs">
                          <StudyProgressBar
                            label="Current study progress"
                            value={runtimeModel.runtime.progressPercent}
                          />
                          <div className="grid grid-cols-2 gap-2 rounded border border-fm-border-subtle p-2.5 tabular-nums">
                            <div>
                              <span className="block text-fm-muted">Active stage</span>
                              <span>{runtimeModel.runtime.activeStageLabel || "—"}</span>
                            </div>
                            <div>
                              <span className="block text-fm-muted">State</span>
                              <span>{runtimeModel.runtime.state || "idle"}</span>
                            </div>
                            <div>
                              <span className="block text-fm-muted">Sim time</span>
                              <span>{simTimeVal}</span>
                            </div>
                            <div>
                              <span className="block text-fm-muted">Step</span>
                              <span>{stepVal}</span>
                            </div>
                            <div>
                              <span className="block text-fm-muted">Max |m × H|</span>
                              <span>{maxTorqueVal}</span>
                            </div>
                            <div>
                              <span className="block text-fm-muted">Max RHS norm</span>
                              <span>{maxRhsNormVal}</span>
                            </div>
                            <div>
                              <span className="block text-fm-muted">Converged</span>
                              <span>{runtimeModel.runtime.converged ?? "—"}</span>
                            </div>
                            <div>
                              <span className="block text-fm-muted">Relax stop criteria</span>
                              <span>{relaxStopVal}</span>
                            </div>
                          </div>
                          {runtimeModel.runtime.commandId ? (
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-fm-muted">Active command</span>
                              <Button
                                size="sm"
                                type="button"
                                variant="ghost"
                                onClick={() =>
                                  onSelectCommandId(
                                    runtimeModel.runtime.commandId ?? null,
                                  )
                                }
                              >
                                <span>{runtimeModel.runtime.commandLabel}</span>
                                <Info aria-hidden="true" size={12} />
                              </Button>
                            </div>
                          ) : null}
                          {runtimeModel.runtime.runtimeProvenance ? (
                            <div className="grid gap-1 rounded border border-fm-border-subtle p-2 font-mono text-xs">
                              <div>
                                Authored:{" "}
                                {runtimeModel.runtime.runtimeProvenance.authored.backend} /{" "}
                                {runtimeModel.runtime.runtimeProvenance.authored.device} ·{" "}
                                {runtimeModel.runtime.runtimeProvenance.authored.precision}
                              </div>
                              <div>
                                Resolved:{" "}
                                {runtimeModel.runtime.runtimeProvenance.resolved.backend !==
                                "not loaded"
                                  ? runtimeModel.runtime.runtimeProvenance.resolved.backend
                                  : (activeLane?.resolved?.discretization ?? "—")}{" "}
                                /{" "}
                                {runtimeModel.runtime.runtimeProvenance.resolved.device !==
                                "not loaded"
                                  ? runtimeModel.runtime.runtimeProvenance.resolved.device
                                  : (activeLane?.resolved?.device ?? "—")}{" "}
                                ·{" "}
                                {runtimeModel.runtime.runtimeProvenance.resolved.engine !==
                                "not loaded"
                                  ? runtimeModel.runtime.runtimeProvenance.resolved.engine
                                  : (activeLane?.resolved?.precision ?? "—")}
                              </div>
                              <div>
                                Fallback:{" "}
                                {runtimeModel.runtime.runtimeProvenance.fallback.status !==
                                "not loaded"
                                  ? runtimeModel.runtime.runtimeProvenance.fallback.status
                                  : "none"}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
}
