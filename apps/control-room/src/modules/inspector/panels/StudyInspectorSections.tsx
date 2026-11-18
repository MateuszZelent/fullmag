"use client";

import {
  Download,
  Info,
  Pause,
  Play,
  RotateCcw,
  Save,
  Scissors,
  SkipForward,
  Square,
  Upload,
} from "lucide-react";
import { type ReactNode } from "react";
import type { CheckpointEntry } from "@/kernel/api/apiTypes";
import type { ActiveLaneCapabilitySnapshot } from "@/kernel/resources/useActiveLaneCapabilities";
import { Button } from "@/shared/ui/Button";
import { FieldRow } from "../primitives/FieldRow";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import {
  isExplicitFdmStudy,
  normalizeDemagRealizationForLane,
  resolveFdmGridPreview,
  validateStudyGlobalDraft,
  type StudyGlobalDraft,
} from "./StudyGlobalAuthoringModel";
import { type StudyInspectorModel, type StudyInspectorSnapshot } from "./StudyInspectorPanelModel";
import { StudySolverPolicyFields } from "./StudyPipelineSection";
import { StudyProgressBar } from "./StudyProgressBar";
import {
  rawStudyStages,
  formatGridVector,
  type StudyCommandRunner,
  type StudyCommandDisabledReason,
  type StageExecutionResourceState,
} from "./studyInspectorShared";

function stageExecutionFeedback(
  resource: StageExecutionResourceState | null | undefined,
): { kind: "error" | "warning"; message: string } | null {
  if (!resource) return null;
  const hasScopedSnapshot = resource.data !== null;
  const errorMessage = resource.error?.message ?? resource.refreshError?.message;
  const detail = errorMessage ? ` ${errorMessage}` : "";

  if (resource.status === "error") {
    return hasScopedSnapshot
      ? {
          kind: "warning",
          message: `Stage telemetry refresh failed. Showing the last confirmed telemetry for the current session/run scope.${detail}`,
        }
      : {
          kind: "error",
          message: `Stage telemetry refresh failed. No snapshot is available for the current session/run scope.${detail}`,
        };
  }

  if (resource.status === "stale") {
    if (resource.error || resource.refreshError) {
      return hasScopedSnapshot
        ? {
            kind: "warning",
            message: `Stage telemetry refresh failed. Showing the last confirmed telemetry for the current session/run scope.${detail}`,
          }
        : {
            kind: "error",
            message: `Stage telemetry refresh failed. No snapshot is available for the current session/run scope.${detail}`,
          };
    }

    return hasScopedSnapshot
      ? {
          kind: "warning",
          message:
            "Stage telemetry is stale. Showing the last confirmed snapshot while refresh is pending.",
        }
      : {
          kind: "warning",
          message:
            "Stage telemetry is stale, but no snapshot matches the current session/run scope.",
        };
  }

  return null;
}

export function StudyRuntimeSection({
  buildStudyProgress,
  commandDisabledReason,
  model,
  onOpenCommand,
  runCommand,
  stageExecution,
  stepValue,
}: {
  buildStudyProgress?: string | null;
  commandDisabledReason: StudyCommandDisabledReason;
  model: StudyInspectorModel;
  onOpenCommand: (commandId: string) => void;
  runCommand: StudyCommandRunner;
  stageExecution?: StageExecutionResourceState | null;
  stepValue: ReactNode;
}) {
  const telemetryFeedback = stageExecutionFeedback(stageExecution);
  return (
    <InspectorGroup title="Runtime" badge={model.runtime.state}>
      {telemetryFeedback ? (
        <FeedbackBanner
          kind={telemetryFeedback.kind}
          message={telemetryFeedback.message}
        />
      ) : null}
      <FieldRow label="Run" value={model.runtime.runId} />
      <FieldRow label="Active stage" value={model.runtime.activeStageLabel} />
      {model.runtime.runtimeProvenance ? (
        <StudyRuntimeProvenanceRows provenance={model.runtime.runtimeProvenance} />
      ) : null}
      <FieldRow
        label="Command"
        value={
          model.runtime.commandId ? (
            <button
              type="button"
              className="fm-study-command-link"
              onClick={() => onOpenCommand(model.runtime.commandId ?? "")}
              title="Open command detail"
            >
              <span>{model.runtime.commandLabel}</span>
              <Info size={12} aria-hidden="true" />
            </button>
          ) : (
            model.runtime.commandLabel
          )
        }
      />
      {model.runtime.commandError ? (
        <FieldRow label="Command error" value={model.runtime.commandError} />
      ) : null}
      {model.runtime.backendDiagnostic ? (
        <FieldRow label="Backend failure" value={model.runtime.backendDiagnostic} />
      ) : null}
      {model.runtime.warnings?.map((warning, index) => (
        <FieldRow key={`${index}:${warning}`} label="Runtime warning" value={warning} />
      ))}
      <FieldRow label="Max torque" value={model.runtime.maxTorque} />
      {model.runtime.torqueDiagnostic ? (
        <FieldRow label="Torque diagnostic" value={model.runtime.torqueDiagnostic} />
      ) : null}
      <FieldRow
        label="Max RHS norm"
        value={model.runtime.maxRhsNorm ?? "unavailable"}
      />
      <FieldRow
        label="Converged"
        value={model.runtime.converged ?? "not reported"}
      />
      {model.runtime.relaxTorqueStop ? (
        <>
          <FieldRow
            label="Relax torque"
            value={model.runtime.relaxTorqueStop.current}
          />
          <FieldRow
            label="Relax threshold"
            value={model.runtime.relaxTorqueStop.threshold}
          />
          <FieldRow
            label="Relax stop"
            value={model.runtime.relaxTorqueStop.status}
          />
        </>
      ) : null}
      {model.runtime.relaxEnergyStop ? (
        <>
          <FieldRow
            label="Energy plateau"
            value={model.runtime.relaxEnergyStop.current}
          />
          <FieldRow
            label="Energy threshold"
            value={model.runtime.relaxEnergyStop.threshold}
          />
          <FieldRow
            label="Energy stop"
            value={model.runtime.relaxEnergyStop.status}
          />
        </>
      ) : null}
      {model.runtime.relaxTimeStop ? (
        <>
          <FieldRow
            label="Physical time"
            value={model.runtime.relaxTimeStop.elapsed}
          />
          <FieldRow
            label="Time budget"
            value={model.runtime.relaxTimeStop.budget}
          />
          <FieldRow
            label="Time status"
            value={model.runtime.relaxTimeStop.status}
          />
        </>
      ) : null}
      <FieldRow label="Step" value={stepValue} />
      {buildStudyProgress ? <p role="status">{buildStudyProgress}</p> : null}
      <StudyProgressBar
        label="Current study progress"
        value={model.runtime.progressPercent}
      />
      <div className="fm-inspector-toolbar">
        <StudyCommandButton
          commandId="study.run"
          disabledReason={commandDisabledReason("study.run")}
          icon={<Play size={13} />}
          label="Compute"
          onRun={runCommand}
        />
        <StudyCommandButton
          commandId="study.build-and-run"
          disabledReason={commandDisabledReason("study.build-and-run")}
          icon={<Play size={13} />}
          label="Build + Study"
          onRun={runCommand}
        />
        {buildStudyProgress ? (
          <StudyCommandButton
            commandId="study.cancel-build-and-run"
            disabledReason={commandDisabledReason("study.cancel-build-and-run")}
            icon={<Square size={13} />}
            label="Cancel Build + Study"
            onRun={runCommand}
            variant="ghost"
          />
        ) : null}
        <StudyCommandButton
          commandId="study.pause"
          disabledReason={commandDisabledReason("study.pause")}
          icon={<Pause size={13} />}
          label="Pause"
          onRun={runCommand}
          variant="ghost"
        />
        <StudyCommandButton
          commandId="study.resume"
          disabledReason={commandDisabledReason("study.resume")}
          icon={<Play size={13} />}
          label="Resume"
          onRun={runCommand}
          variant="ghost"
        />
        <StudyCommandButton
          commandId="study.skip"
          disabledReason={commandDisabledReason("study.skip")}
          icon={<SkipForward size={13} />}
          label="Skip"
          onRun={runCommand}
          variant="ghost"
        />
        <StudyCommandButton
          commandId="study.stop"
          disabledReason={commandDisabledReason("study.stop")}
          icon={<Square size={13} />}
          label="Stop"
          onRun={runCommand}
          variant="danger"
        />
      </div>
    </InspectorGroup>
  );
}

function StudyRuntimeProvenanceRows({
  provenance,
}: {
  provenance: NonNullable<StudyInspectorModel["runtime"]["runtimeProvenance"]>;
}) {
  return (
    <div className="fm-study-runtime-provenance" data-provenance-status={provenance.fallback.status}>
      <FieldRow label="Authored intent backend" value={provenance.authored.backend} mono />
      <FieldRow label="Authored intent device" value={provenance.authored.device} mono />
      <FieldRow label="Authored intent mode" value={provenance.authored.mode} mono />
      <FieldRow label="Authored intent precision" value={provenance.authored.precision} mono />
      <FieldRow label="Authored intent provenance" value={provenance.sources.authored} mono />
      <FieldRow label="Effective request backend" value={provenance.effective.backend} mono />
      <FieldRow label="Effective request device" value={provenance.effective.device} mono />
      <FieldRow label="Effective request mode" value={provenance.effective.mode} mono />
      <FieldRow label="Effective request precision" value={provenance.effective.precision} mono />
      <FieldRow label="Effective request provenance" value={provenance.sources.effective} mono />
      <FieldRow label="Resolved backend" value={provenance.resolved.backend} mono />
      <FieldRow label="Resolved device" value={provenance.resolved.device} mono />
      <FieldRow label="Resolved mode" value={provenance.resolved.mode} mono />
      <FieldRow label="Resolved precision" value={provenance.resolved.precision} mono />
      <FieldRow label="Resolved runtime family" value={provenance.resolved.runtimeFamily} mono />
      <FieldRow label="Resolved engine" value={provenance.resolved.engine} mono />
      <FieldRow label="Fallback status" value={provenance.fallback.status} status={provenance.fallback.status} />
      <FieldRow label="Fallback reason" value={provenance.fallback.reason} />
      <FieldRow label="Fallback engines" value={`${provenance.fallback.originalEngine} → ${provenance.fallback.fallbackEngine}`} mono />
      <FieldRow label="Fallback message" value={provenance.fallback.message} />
    </div>
  );
}

export function StudySelectedStageSection({
  model,
  stageExecutionRevision,
}: {
  model: StudyInspectorModel;
  stageExecutionRevision?: number | null;
}) {
  const selectedStage = model.selectedStage;
  const eigenmodeSolving =
    selectedStage !== null &&
    selectedStage.kind.toLowerCase().includes("eigen") &&
    ["accepted", "dispatched", "materializing", "pending", "queued", "running"].includes(
      selectedStage.status.toLowerCase(),
    );
  const selectedStageHasProgress =
    selectedStage !== null &&
    (selectedStage.progressLabel != null ||
      selectedStage.progressDetail != null ||
      selectedStage.progressPercent > 0);
  const selectedStageProgressValue =
    eigenmodeSolving && !selectedStageHasProgress
      ? null
      : (selectedStage?.progressPercent ?? null);
  const selectedStageProgressLabel =
    selectedStage?.progressLabel ??
    (eigenmodeSolving ? "waiting for solver progress telemetry" : undefined);

  return (
    <InspectorGroup
      title="Selected Stage"
      badge={selectedStage?.status ?? "none"}
    >
      <FieldRow label="Kind" value={selectedStage?.kind ?? "none"} />
      <FieldRow label="Status" value={selectedStage?.status ?? "none"} />
      {eigenmodeSolving ? (
        <FieldRow
          label="Eigenmode solve progress"
          value={selectedStageProgressLabel}
        />
      ) : null}
      {selectedStage?.progressDetail ? (
        <FieldRow label="Progress detail" value={selectedStage.progressDetail} />
      ) : null}
      <FieldRow
        label="Stop reason"
        value={selectedStage?.stopReason ?? "not available"}
      />
      <FieldRow
        label="Completed"
        value={selectedStage?.completedAtIso ?? "not completed"}
      />
      <FieldRow
        label="Command"
        value={selectedStage?.commandId ?? "not linked"}
      />
      <FieldRow
        label="Mesh generation"
        value={selectedStage?.meshGenerationId ?? "unknown"}
        mono
      />
      <FieldRow
        label="Mesh revision"
        value={
          selectedStage?.meshRevision === null ||
          selectedStage?.meshRevision === undefined
            ? "unknown"
            : String(selectedStage.meshRevision)
        }
      />
      <FieldRow
        label="Topology fingerprint"
        value={selectedStage?.meshTopologyFingerprint ?? "unknown"}
        mono
      />
      {selectedStage?.transition ? (
        <>
          <FieldRow
            label="State transition"
            value={selectedStage.transition.label ?? "declared"}
          />
          <FieldRow
            label="Transition kind"
            value={selectedStage.transition.kind ?? "not available"}
          />
          <FieldRow
            label="Transition reason"
            value={selectedStage.transition.reason ?? "not available"}
          />
          <FieldRow
            label="Transfer operator"
            value={selectedStage.transition.transferOperator ?? "not available"}
          />
        </>
      ) : null}
      {selectedStage?.runtimeMetric ? (
        <>
          <FieldRow
            label="Stop metric"
            value={selectedStage.runtimeMetric.name}
          />
          <FieldRow
            label="Metric value"
            value={selectedStage.runtimeMetric.value}
          />
          <FieldRow
            label="Metric threshold"
            value={selectedStage.runtimeMetric.threshold}
          />
        </>
      ) : null}
      <FieldRow
        label="Torque stop"
        value={selectedStage?.torqueToleranceFormatted ?? "not set"}
      />
      <FieldRow
        label="Energy stop"
        value={selectedStage?.energyTolerance ?? "not set"}
      />
      <FieldRow
        label="Step budget"
        value={selectedStage?.maxSteps ?? "not set"}
      />
      <FieldRow
        label="Time budget"
        value={selectedStage?.untilSeconds ?? "not set"}
        unit={selectedStage?.untilSeconds ? "s" : undefined}
      />
      <FieldRow
        label="Checkpoint"
        value={selectedStage?.checkpointRef ?? "not available"}
      />
      <FieldRow
        label="Artifacts"
        value={
          selectedStage?.artifactRefs.length
            ? selectedStage.artifactRefs.join(", ")
            : "none"
        }
      />
      <FieldRow
        label="Stage resource"
        value={
          stageExecutionRevision === undefined || stageExecutionRevision === null
            ? "not loaded"
            : `simulation/stages/execution@${stageExecutionRevision}`
        }
      />
      <StudyProgressBar
        indeterminate={eigenmodeSolving && !selectedStageHasProgress}
        label={
          eigenmodeSolving
            ? "Eigenmode solve progress"
            : "Selected stage progress"
        }
        statusLabel={selectedStage?.progressLabel ?? undefined}
        value={selectedStageProgressValue}
      />
    </InspectorGroup>
  );
}

export function StudyBoundarySection({
  activeLane,
  algorithmsAvailable,
  authoringBusy,
  authoringFeedback,
  draft,
  executionProfileBound = false,
  executionProfileDraftDirty = false,
  magneticObjectIds: _magneticObjectIds,
  model,
  magneticObjectCount,
  onCommit,
  onUpdate,
  sessionDiscretization,
  requestedDiscretization,
  scene,
  sceneRevision,
  sceneStatus,
  snapshot,
}: {
  activeLane?: ActiveLaneCapabilitySnapshot | null;
  algorithmsAvailable?: readonly string[];
  authoringBusy: boolean;
  authoringFeedback: {
    kind: "error" | "success" | "warning";
    message: string;
  } | null;
  draft: StudyGlobalDraft;
  executionProfileBound?: boolean;
  executionProfileDraftDirty?: boolean;
  magneticObjectIds?: readonly string[];
  model: StudyInspectorModel;
  magneticObjectCount?: number;
  onCommit: () => void;
  onUpdate: (patch: Partial<StudyGlobalDraft>) => void;
  requestedDiscretization?: string | null;
  sessionDiscretization?: string | null;
  scene?: unknown;
  sceneRevision?: number | string | null;
  sceneStatus?: string;
  snapshot: StudyInspectorSnapshot;
}) {
  const laneRequestedBackend = executionProfileBound
    ? null
    : draft.requestedBackend;
  const explicitFdm = isExplicitFdmStudy({
    requestedBackend: laneRequestedBackend,
    requestedDiscretization,
    sessionDiscretization,
  });
  const demagRealization = normalizeDemagRealizationForLane(
    draft.demagRealization,
    {
      requestedBackend: laneRequestedBackend,
      requestedDiscretization,
      sessionDiscretization,
    },
  );
  const fdm = draft.fdm ?? {
    boundaryCorrection: "",
    boundaryDeltaMin: "",
    boundaryPhiFloor: "",
    commonCells: "",
    commonCellsXy: "",
    defaultCell: "",
    demagExplain: true,
    demagMode: "auto",
    demagStrategy: demagRealization,
    perMagnet: "",
  };
  const validation = validateStudyGlobalDraft(draft, {
    studyStages: rawStudyStages(scene),
    activeLane,
    algorithmsAvailable,
    executionProfileBound,
    magneticObjectCount,
    magneticObjectIds: _magneticObjectIds,
    requestedDiscretization,
    sessionDiscretization,
  });
  const hasErrors = validation.some((issue) => issue.severity === "error");
  const singleGridUnsupported = explicitFdm && (magneticObjectCount ?? 0) > 1;
  const gridPreview = explicitFdm
    ? resolveFdmGridPreview(scene, draft)
    : null;
  const gridApplyDisabled =
    authoringBusy ||
    executionProfileDraftDirty ||
    hasErrors ||
    (sceneStatus !== undefined && sceneStatus !== "ready");
  return (
    <InspectorGroup
      title="Global Study Settings"
      badge={executionProfileBound ? "Profile bound" : snapshot.requested.backend}
    >
      <FieldRow label="Current exchange" value={model.boundary.exchangeEnabled} />
      <FieldRow label="Current demag term" value={model.boundary.demagEnabled} />
      <FieldRow label="Current demag" value={model.boundary.demagRealization} />
      <FieldRow label="Current field" value={model.boundary.externalField} />
      <FieldRow label="Current solver" value={model.boundary.solver} />
      <FieldRow
        label={explicitFdm ? "Current FDM demag strategy" : "Current FEM demag policy"}
        value={
          explicitFdm
            ? model.boundary.demagRealization
            : model.boundary.femDemagSolverPolicy
        }
      />
      <FieldRow label="Current CPU threads" value={model.requested.cpuThreads} />
      <FieldRow
        label="Parallel execution"
        value={
          draft.parallelExecution.mode === "serial"
            ? "serial (adaptive targets unused)"
            : draft.parallelExecution.mode === "adaptive"
              ? `adaptive, CPU ${draft.parallelExecution.maxCpuPercent}%`
              : `invalid mode: ${draft.parallelExecution.mode}`
        }
      />
      {executionProfileBound ? (
        <p role="status">
          An immutable execution profile is bound. Legacy backend, device, precision, mode, and CPU thread fields are inactive; edit them in Study Execution Profile.
        </p>
      ) : null}
      {executionProfileDraftDirty ? (
        <FeedbackBanner
          kind="warning"
          message="Apply or cancel the Study execution profile draft before saving global Study settings."
        />
      ) : null}
      <FormField
        disabled={executionProfileBound}
        label="Backend"
        type="select"
        value={draft.requestedBackend}
        onChange={(event) =>
          onUpdate({ requestedBackend: event.target.value })
        }
      >
        <option value="auto">Auto</option>
        <option value="fdm">FDM</option>
        <option value="fem">FEM</option>
        <option value="hybrid">Hybrid</option>
      </FormField>
      <FormField
        disabled={executionProfileBound}
        label="Device"
        type="select"
        value={draft.requestedDevice}
        onChange={(event) => onUpdate({ requestedDevice: event.target.value })}
      >
        <option value="auto">Auto</option>
        <option value="cpu">CPU</option>
        <option value="gpu">GPU</option>
      </FormField>
      <FormField
        disabled={executionProfileBound}
        label="Precision"
        type="select"
        value={draft.requestedPrecision}
        onChange={(event) =>
          onUpdate({ requestedPrecision: event.target.value })
        }
      >
        <option value="double">Double</option>
        <option value="single">Single</option>
      </FormField>
      <FormField
        disabled={executionProfileBound}
        label="Mode"
        type="select"
        value={draft.requestedMode}
        onChange={(event) => onUpdate({ requestedMode: event.target.value })}
      >
        <option value="strict">Strict</option>
        <option value="extended">Extended</option>
        <option value="hybrid">Hybrid</option>
      </FormField>
      <FormField
        disabled={executionProfileBound}
        label="CPU threads"
        hint="Blank keeps automatic runtime thread selection."
        value={draft.requestedCpuThreads}
        onChange={(event) =>
          onUpdate({ requestedCpuThreads: event.target.value })
        }
      />
      <FormField
        disabled={explicitFdm}
        label="Independent k points"
        hint="Adaptive schedules independent k points for FEM CPU with soft CPU and memory targets; serial mode ignores these targets. Settings apply on the next run."
        type="select"
        value={draft.parallelExecution.mode}
        onChange={(event) =>
          onUpdate({
            parallelExecution: {
              ...draft.parallelExecution,
              mode: event.target.value,
            },
          })
        }
      >
        {draft.parallelExecution.mode !== "serial" &&
        draft.parallelExecution.mode !== "adaptive" ? (
          <option value={draft.parallelExecution.mode}>
            Invalid imported mode: {draft.parallelExecution.mode}
          </option>
        ) : null}
        <option value="serial">Serial</option>
        <option value="adaptive">Adaptive</option>
      </FormField>
      <FormField
        disabled={draft.parallelExecution.mode !== "adaptive" || explicitFdm}
        label="Maximum CPU target (%)"
        hint="Adaptive only: target within the CPU allocation; brief peaks can exceed it. Serial mode ignores this field."
        value={draft.parallelExecution.maxCpuPercent}
        onChange={(event) =>
          onUpdate({
            parallelExecution: {
              ...draft.parallelExecution,
              maxCpuPercent: event.target.value,
            },
          })
        }
      />
      <FormField
        disabled={draft.parallelExecution.mode !== "adaptive" || explicitFdm}
        label="Maximum memory target (%)"
        hint="Adaptive only: target within allocated memory; the reserve is kept in addition. Serial mode ignores this field."
        value={draft.parallelExecution.maxMemoryPercent}
        onChange={(event) =>
          onUpdate({
            parallelExecution: {
              ...draft.parallelExecution,
              maxMemoryPercent: event.target.value,
            },
          })
        }
      />
      <FormField
        disabled={draft.parallelExecution.mode !== "adaptive" || explicitFdm}
        label="Memory reserve (MiB)"
        hint="Adaptive only: the reserve is kept in addition to the memory target. Values must convert exactly to safe API bytes; serial mode ignores this field."
        value={draft.parallelExecution.memoryReserveMiB}
        onChange={(event) =>
          onUpdate({
            parallelExecution: {
              ...draft.parallelExecution,
              memoryReserveMiB: event.target.value,
            },
          })
        }
      />
      <FormField
        disabled={draft.parallelExecution.mode !== "adaptive" || explicitFdm}
        label="Maximum workers"
        hint="Adaptive only: blank lets the scheduler choose from available capacity. Serial mode ignores this field."
        value={draft.parallelExecution.maxWorkers}
        onChange={(event) =>
          onUpdate({
            parallelExecution: {
              ...draft.parallelExecution,
              maxWorkers: event.target.value,
            },
          })
        }
      />
      <FormField
        disabled={draft.parallelExecution.mode !== "adaptive" || explicitFdm}
        label="Threads per worker"
        hint="Adaptive only: applies to each independent k worker. Serial mode ignores this field."
        value={draft.parallelExecution.threadsPerWorker}
        onChange={(event) =>
          onUpdate({
            parallelExecution: {
              ...draft.parallelExecution,
              threadsPerWorker: event.target.value,
            },
          })
        }
      />
      <FormField
        label="Exchange enabled"
        checked={draft.exchangeEnabled}
        type="checkbox"
        onChange={(event) => onUpdate({ exchangeEnabled: event.target.checked })}
      />
      <FormField
        label="Demag enabled"
        checked={draft.demagEnabled}
        type="checkbox"
        onChange={(event) => onUpdate({ demagEnabled: event.target.checked })}
      />
      <FormField
        label={explicitFdm ? "FDM demag" : "Demag"}
        type="select"
        value={demagRealization}
        onChange={(event) =>
          onUpdate({
            demagRealization: event.target.value,
            ...(explicitFdm
              ? {
                  fdm: {
                    ...fdm,
                    demagStrategy: event.target.value,
                  },
                }
              : {}),
          })
        }
      >
        {explicitFdm ? (
          <>
            <option value="auto">Auto</option>
            <option disabled={singleGridUnsupported} value="single_grid">
              FDM single grid
              {singleGridUnsupported ? " (unsupported for multiple magnets)" : ""}
            </option>
            <option value="multilayer_convolution">
              FDM multilayer convolution
            </option>
          </>
        ) : (
          <>
            <option value="auto">Auto</option>
            <option value="poisson_robin">Poisson Robin</option>
            <option value="poisson_dirichlet">Poisson Dirichlet</option>
            <option value="fredkin_koehler">Fredkin Koehler</option>
            <option value="bem">BEM</option>
            <option value="fmm">FMM</option>
            <option value="airbox_robin">Airbox Robin</option>
          </>
        )}
      </FormField>
      {explicitFdm ? (
        <>
          <FormField
            label="FDM default cell"
            hint="dx, dy, dz in metres. Leave blank when every magnet has a per-object grid."
            unit="m"
            value={fdm.defaultCell}
            onChange={(event) =>
              onUpdate({ fdm: { ...fdm, defaultCell: event.target.value } })
            }
          />
          <InspectorGroup title="FDM Grid Preview" badge={gridPreview ? "derived" : "not available"}>
            <FieldRow label="Base scene revision" value={sceneRevision ?? "not available"} />
            {gridPreview && gridPreview.entries.length > 0 ? (
              <>
                {gridPreview.entries.map((entry) => (
                  <div className="fm-inspector-grid-preview" key={entry.objectId}>
                    <FieldRow label={`${entry.objectId} cells`} value={entry.counts.join(" × ")} />
                    <FieldRow
                      label={`${entry.objectId} covered extent`}
                      value={`${formatGridVector(entry.extent)} m`}
                    />
                  </div>
                ))}
                <FieldRow label="Total cells (preview)" value={String(gridPreview.totalCellCount)} />
              </>
            ) : (
              <FieldRow
                label="Grid preview"
                value="Add a valid FDM cell and magnetic object geometry."
              />
            )}
            <FieldRow
              label="Topology after Apply Grid"
              value={sceneStatus === "ready" ? "queued for the next FDM realization" : "waiting for current scene"}
            />
          </InspectorGroup>
          <FormField
            label="FDM per-magnet grids"
            hint='JSON object keyed by canonical magnet object_id, for example {"free":{"cell":[2e-9,2e-9,1e-9]}}.'
            rows={3}
            type="textarea"
            value={fdm.perMagnet}
            onChange={(event) =>
              onUpdate({ fdm: { ...fdm, perMagnet: event.target.value } })
            }
          />
          <FormField
            label="FDM demag mode"
            type="select"
            value={fdm.demagMode}
            onChange={(event) =>
              onUpdate({ fdm: { ...fdm, demagMode: event.target.value } })
            }
          >
            <option value="auto">Auto</option>
            <option value="two_d_stack">2-D stack</option>
            <option value="three_d">3-D</option>
          </FormField>
          <FormField
            label="Common convolution cells"
            hint="Nx, Ny, Nz; mutually exclusive with common XY cells."
            value={fdm.commonCells}
            onChange={(event) =>
              onUpdate({ fdm: { ...fdm, commonCells: event.target.value } })
            }
          />
          <FormField
            label="Common convolution cells XY"
            hint="Nx, Ny for the two-dimensional stack path."
            value={fdm.commonCellsXy}
            onChange={(event) =>
              onUpdate({ fdm: { ...fdm, commonCellsXy: event.target.value } })
            }
          />
          <FormField
            label="Explain FDM demag plan"
            checked={fdm.demagExplain}
            type="checkbox"
            onChange={(event) =>
              onUpdate({ fdm: { ...fdm, demagExplain: event.target.checked } })
            }
          />
          <FormField
            label="Boundary correction"
            type="select"
            value={fdm.boundaryCorrection}
            onChange={(event) =>
              onUpdate({ fdm: { ...fdm, boundaryCorrection: event.target.value } })
            }
          >
            <option value="">Backend default</option>
            <option value="none">None</option>
            <option value="volume">Volume (T0)</option>
            <option value="full">Full (T1)</option>
          </FormField>
          <FormField
            label="Boundary phi floor"
            hint="Effective volume fraction in (0, 1)."
            value={fdm.boundaryPhiFloor}
            onChange={(event) =>
              onUpdate({ fdm: { ...fdm, boundaryPhiFloor: event.target.value } })
            }
          />
          <FormField
            label="Boundary delta minimum"
            hint="Minimum intersection distance in metres."
            unit="m"
            value={fdm.boundaryDeltaMin}
            onChange={(event) =>
              onUpdate({ fdm: { ...fdm, boundaryDeltaMin: event.target.value } })
            }
          />
        </>
      ) : null}
      <FormField
        label="External field"
        hint="B_ext vector in T. Leave blank to remove the global field."
        unit="T"
        value={draft.externalField}
        onChange={(event) => onUpdate({ externalField: event.target.value })}
      />
      <StudySolverPolicyFields
        algorithmsAvailable={algorithmsAvailable}
        draft={draft.solver}
        onUpdate={(patch) =>
          onUpdate({ solver: { ...draft.solver, ...patch } })
        }
        requestedBackend={draft.requestedBackend}
        requestedDevice={draft.requestedDevice}
        requestedPrecision={draft.requestedPrecision}
      />
      {explicitFdm ? (
        <FieldRow
          label="FEM demag policy"
          value="Not applicable for an explicit FDM lane"
        />
      ) : (
        <FormField
          label="FEM demag policy"
          hint="FEM demag solver policy JSON object."
          rows={4}
          type="textarea"
          value={draft.femDemagSolverPolicy}
          onChange={(event) =>
            onUpdate({ femDemagSolverPolicy: event.target.value })
          }
        />
      )}
      {validation.length > 0 ? (
        <ul className="fm-inspector-validation-list">
          {validation.map((issue) => (
            <li key={`${issue.severity}:${issue.message}`}>
              {issue.severity}: {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      {authoringFeedback ? (
        <FeedbackBanner
          kind={authoringFeedback.kind}
          message={authoringFeedback.message}
        />
      ) : null}
      <div className="fm-inspector-toolbar">
        <Button
          disabled={gridApplyDisabled}
          size="sm"
          title={
            executionProfileDraftDirty
              ? "Apply or cancel the Study execution profile draft first."
              : hasErrors
              ? "Fix global study validation errors before applying the grid."
              : explicitFdm
                ? "Apply the FDM grid policy to the canonical scene"
                : "Save global study settings"
          }
          type="button"
          variant="primary"
          onClick={onCommit}
        >
          <Save size={13} aria-hidden="true" />
          {authoringBusy ? "Saving" : explicitFdm ? "Apply Grid" : "Save globals"}
        </Button>
      </div>
    </InspectorGroup>
  );
}

export function StudyRecoverySection({
  checkpointCount,
  commandDisabledReason,
  latestCheckpoint,
  onImport,
  onRestore,
  runCommand,
}: {
  checkpointCount: number;
  commandDisabledReason: StudyCommandDisabledReason;
  latestCheckpoint: CheckpointEntry | null;
  onImport: () => void;
  onRestore: () => void;
  runCommand: StudyCommandRunner;
}) {
  return (
    <InspectorGroup
      title="Recovery"
      badge={`${checkpointCount}`}
    >
      <FieldRow
        label="Latest checkpoint"
        value={latestCheckpoint?.checkpoint_id ?? "not available"}
      />
      <FieldRow
        label="Resume class"
        value={latestCheckpoint?.resume_class ?? "not available"}
      />
      <FieldRow
        label="Checkpoint step"
        value={latestCheckpoint?.step ?? "not available"}
      />
      <div className="fm-inspector-toolbar">
        <StudyCommandButton
          commandId="study.save-checkpoint"
          disabledReason={commandDisabledReason("study.save-checkpoint")}
          icon={<Save size={13} />}
          label="Save"
          onRun={runCommand}
          variant="ghost"
        />
        <StudyCommandButton
          commandId="study.restore-checkpoint"
          disabledReason={commandDisabledReason("study.restore-checkpoint")}
          icon={<RotateCcw size={13} />}
          label="Restore"
          onRun={onRestore}
          variant="ghost"
        />
        <StudyCommandButton
          commandId="study.import-state"
          disabledReason={commandDisabledReason("study.import-state")}
          icon={<Upload size={13} />}
          label="Import"
          onRun={onImport}
          variant="ghost"
        />
        <StudyCommandButton
          commandId="study.export-state"
          disabledReason={commandDisabledReason("study.export-state")}
          icon={<Download size={13} />}
          label="Export"
          onRun={runCommand}
          variant="ghost"
        />
        <StudyCommandButton
          commandId="study.discard-paused-state"
          disabledReason={commandDisabledReason("study.discard-paused-state")}
          icon={<Scissors size={13} />}
          label="Discard"
          onRun={runCommand}
          variant="danger"
        />
      </div>
    </InspectorGroup>
  );
}

export function StudyHistorySection({
  energyStep,
  returnedRows,
  totalEnergy,
  totalRows,
}: {
  energyStep: ReactNode;
  returnedRows: ReactNode;
  totalEnergy: ReactNode;
  totalRows: ReactNode;
}) {
  return (
    <InspectorGroup
      title="Run History"
      badge={`${returnedRows}`}
    >
      <FieldRow label="Energy step" value={energyStep} />
      <FieldRow label="Total energy" value={totalEnergy} unit="J" />
      <FieldRow label="Returned rows" value={returnedRows} />
      <FieldRow label="Total rows" value={totalRows} />
    </InspectorGroup>
  );
}

export function StudyCommandButton({
  commandId,
  disabledReason,
  icon,
  label,
  onRun,
  variant,
}: {
  commandId: string;
  disabledReason: string | null;
  icon: ReactNode;
  label: string;
  onRun: (commandId: string) => void;
  variant?: "danger" | "ghost" | "primary" | "secondary";
}) {
  const enabled = disabledReason === null;
  const title = disabledReason ?? label;

  return (
    <Button
      size="sm"
      type="button"
      variant={variant}
      disabled={!enabled}
      aria-label={enabled ? label : `${label}: ${disabledReason}`}
      title={title}
      onClick={() => onRun(commandId)}
    >
      {icon}
      {label}
    </Button>
  );
}
