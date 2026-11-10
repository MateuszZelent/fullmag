"use client";

import { useCallback, useRef, useState } from "react";

import { useKernel } from "@/kernel/KernelContext";
import {
  getStageInitialStateChoice,
  matchesPreparedStageInitialState,
  preparedStageInitialStateChoice,
  setStageInitialStateChoice,
  type StageInitialStateChoice,
} from "@/kernel/runtime/studyStageInitialState";

import { readStudyStageSource } from "@/shared/domain/study/studyStageSource";

import type { InspectorPanelProps } from "../inspectorTypes";
import { useInspectorEditSession, useRegisterInspectorEditSession } from "../InspectorEditSession";

import { isEditablePipelineStage, validateStudyStageDraft } from "./StudyStageAuthoringModel";
import { useStudyInspectorPanelController } from "./StudyInspectorPanel";
import { ChangeDeviceStageInspector } from "./stages/ChangeDeviceStageInspector";
import { AddFieldDriveStageInspector } from "./stages/AddFieldDriveStageInspector";
import { AntennaFieldSolveStageInspector } from "./stages/AntennaFieldSolveStageInspector";
import { AutosaveStageInspector } from "./stages/AutosaveStageInspector";
import { EigenmodesStageInspector } from "./stages/EigenmodesStageInspector";
import { FrequencyResponseStageInspector } from "./stages/FrequencyResponseStageInspector";
import { FftResponseStageInspector } from "./stages/FftResponseStageInspector";
import { HysteresisStageInspector } from "./stages/HysteresisStageInspector";
import { resolveHysteresisInspectorView } from "./stages/hysteresis/HysteresisInspectorUtils";
import { RelaxStageInspector } from "./stages/RelaxStageInspector";
import { RunStageInspector } from "./stages/RunStageInspector";
import { SaveStateStageInspector } from "./stages/SaveStateStageInspector";
import { TableAutosaveStageInspector } from "./stages/TableAutosaveStageInspector";
import { UnsupportedStageInspector } from "./stages/UnsupportedStageInspector";
import { StageInitialStateSelector } from "./stages/StageInitialStateSelector";
import { StageTextureAssignmentsEditor } from "./stages/StageTextureAssignmentsEditor";
import type { FrequencyDomainAuthoringView } from "./stages/StageInspectorFrame";
import { validateStudyWorkflow } from "./stages/studyWorkflowState";

export function StudyStageInspectorRouter({ selection }: InspectorPanelProps) {
  const {
    commandDisabledReason,
    commitStageDrafts,
    dispatch,
    k0ModalReadinessFor,
    model,
    modelReadiness,
    runtimeStatus,
    runCommand,
    runStage,
    stageRunDisabledReason,
    scene,
    sceneHasPayload,
    sceneRevision,
    sceneStageCount,
    sessionScopeKey,
    stageExecution,
    state,
  } = useStudyInspectorPanelController(selection);
  const stageId = selection.ref?.type === "study-stage" ? selection.ref.stageId : null;
  const launchKey = JSON.stringify([sessionScopeKey, stageId]);
  const [textureEditorKey, setTextureEditorKey] = useState<string | null>(null);
  const textureEditing = textureEditorKey === launchKey;
  const textureEditBlockReason = textureEditing ? "Add or cancel the pending texture change." : undefined;
  const canonicalIndex = state.stageDrafts.findIndex((draft) => draft.pipelineNodeId === stageId);
  const selectedIndex = state.stageDrafts.some((draft) => draft.pipelineNodeId)
    ? canonicalIndex
    : model.selectedStage?.index ?? state.selectedDraftIndex;
  const draft = state.stageDrafts[selectedIndex] ?? null;
  const localValidation = draft
    ? validateStudyStageDraft(draft, {
        activeLane: runtimeStatus?.capabilities.active_lane ?? null,
        algorithmsAvailable: runtimeStatus?.capabilities.algorithms_available,
        backend: model.requested.backend,
        demagEnabled: state.globalDraft.demagEnabled,
        device: model.requested.device,
        ...k0ModalReadinessFor(draft),
        mode: model.requested.mode,
      })
    : [];
  const validation = [
    ...localValidation,
    ...validateStudyWorkflow(state.stageDrafts).flatMap((issue) =>
      issue.index === selectedIndex
        ? [{ message: issue.message, severity: issue.severity }]
        : [],
    ),
  ];
  const workflowValidation = validateStudyWorkflow(state.stageDrafts);
  const allStageValidation = state.stageDrafts.flatMap((stageDraft, index) => [
    ...validateStudyStageDraft(stageDraft, {
      activeLane: runtimeStatus?.capabilities.active_lane ?? null,
      algorithmsAvailable: runtimeStatus?.capabilities.algorithms_available,
      backend: model.requested.backend,
      demagEnabled: state.globalDraft.demagEnabled,
      device: model.requested.device,
      mode: model.requested.mode,
      precision: state.globalDraft.requestedPrecision,
    }),
    ...workflowValidation.flatMap(({ index: issueIndex, message, severity }) =>
      issueIndex === index ? [{ message, severity }] : [],
    ),
  ]);
  const resetStageDrafts = useCallback(
    () => {
      setTextureEditorKey(null);
      dispatch({ type: "revertStageDrafts" });
    },
    [dispatch],
  );
  const stagesDirty = JSON.stringify(state.stageDrafts) !== JSON.stringify(state.baselineStageDrafts);
  useRegisterInspectorEditSession(
    "staged",
    state.authoringBusy,
    stagesDirty || textureEditing,
    !textureEditing && !(draft?.pipelineNodeId ? validation : allStageValidation).some((issue) => issue.severity === "error"),
    state.authoringBusy ? "Study stage changes are being saved." : undefined,
    commitStageDrafts,
    resetStageDrafts,
    { applyBlockReason: textureEditBlockReason, historyMode: "mutation-owned" },
  );
  const selectedStageKind = model.selectedStage?.kind ?? draft?.kind ?? null;
  const inspectorKind = draft?.pipelineNodeId && draft.kind === "unsupported"
    ? "unsupported" : resolveStudyStageInspectorKind(selection.kind, selectedStageKind);
  const frequencyDomainAuthoringView =
    resolveFrequencyDomainAuthoringView(selection.kind);
  const hysteresisView =
    inspectorKind === "hysteresis"
      ? resolveHysteresisInspectorView(selection.nodeId)
      : "overview";
  const kernel = useKernel();
  const form = useInspectorEditSession();
  const stageRunPending = useRef(false);
  const [launching, setLaunching] = useState(false);
  const [launchFeedback, setLaunchFeedback] = useState<{ key: string; message: string; failed: boolean } | null>(null);
  const displayedRevision = scene.data?.revision;
  const committedRevision = scene.status === "ready" && typeof displayedRevision === "number" &&
    displayedRevision === runtimeStatus?.resources.scene_revision ? displayedRevision : null;
  const pinnedSource = stageId
    ? getStageInitialStateChoice(kernel.api, sessionScopeKey, stageId)
    : undefined;
  const preparedSource = preparedStageInitialStateChoice(
    modelReadiness.status === "ready" ? modelReadiness.data : null,
    committedRevision,
  );
  const choice = pinnedSource?.choice;
  const staleSource = pinnedSource !== undefined && committedRevision !== null &&
    (pinnedSource.sceneRevision !== committedRevision ||
      (choice?.kind === "prepared" && !matchesPreparedStageInitialState(choice, preparedSource)));
  let sourceBlockedReason = null;
  if (staleSource) {
    sourceBlockedReason = "Choose the initial magnetization for the current saved scene and preview.";
  } else if (pinnedSource && committedRevision === null) {
    sourceBlockedReason = "Wait for the saved scene to refresh before using the chosen source.";
  } else if (stagesDirty && choice?.kind === "prepared") {
    sourceBlockedReason = "Save the stage first, then choose a prepared magnetization for the saved scene.";
  }
  const changeInitialState = (choice: StageInitialStateChoice) => {
    if (!stageId || !sessionScopeKey || committedRevision === null ||
        kernel.commands.getSessionScopeKey() !== sessionScopeKey) return;
    setStageInitialStateChoice(kernel.api, sessionScopeKey, stageId, committedRevision, choice);
    kernel.commands.refresh();
  };
  const stageSource = readStudyStageSource(scene.data?.study);
  const stageTextureSupported = stageSource.kind === "pipeline"
    ? stageSource.entries.every((item) => !item.enabled ||
        ["run", "relax", "set_field", "set_current", "add_field_drive",
          "remove_field_drive", "table_autosave", "autosave"].includes(item.stageKind ?? ""))
    : stageSource.kind === "flat" && state.stageDrafts.every((item) => item.kind === "run" || item.kind === "relax");
  const textureAuthoring = scene.data && draft &&
    (inspectorKind === "run" || inspectorKind === "relax") ? (
      <StageTextureAssignmentsEditor
        key={launchKey}
        disabledReason={launching || state.authoringBusy
          ? "Wait for the current stage request."
          : stageTextureSupported ? null : "Texture changes require an ordered Run and Relax Study."}
        onChange={(value) => dispatch({
          type: "updateStageDraft", index: selectedIndex, patch: { stageMagnetizationAssignments: value },
        })}
        onOpenChange={(open) => setTextureEditorKey(open ? launchKey : null)}
        open={textureEditing}
        scene={scene.data}
        value={draft.stageMagnetizationAssignments}
      />
    ) : undefined;
  const baseline = state.baselineStageDrafts[selectedIndex];
  const disabledStageReason = draft?.pipelineAncestorsEnabled === false
    ? "Enable the parent group before starting this stage."
    : draft?.stageEnabled === false ? "Enable and save this stage before starting it." : undefined;
  const stageLaunch = stageId && stageId === draft?.stageId &&
    (inspectorKind === "run" || inspectorKind === "relax") ? {
      disabledReason: launching
        ? "The stage request is in progress."
        : textureEditBlockReason ?? disabledStageReason ?? sourceBlockedReason ??
          stageRunDisabledReason(stageId, stagesDirty, form),
      feedback: launchFeedback?.key === launchKey ? launchFeedback : null,
      initialStateControl: (
        <StageInitialStateSelector
          key={launchKey}
          stageId={stageId}
          sceneRevision={committedRevision}
          choice={choice ?? { kind: "default_for_target" }}
          preparedSource={preparedSource}
          stale={staleSource}
          hasAuthoredReset={Boolean(baseline?.scriptMagnetizationAssignments || baseline?.stageMagnetizationAssignments)}
          disabled={launching || state.authoringBusy}
          onChange={changeInitialState}
          onPreviewResult={kernel.savedResultsPlayback
            ? (result) => kernel.savedResultsPlayback?.openStudyResult(result)
            : undefined}
        />
      ),
      label: launching
        ? state.authoringBusy ? "Saving stage…" : "Starting stage…"
        : stagesDirty ? "Save and run this stage" : "Run this stage",
      onRun: async () => {
        if (stageRunPending.current || sourceBlockedReason || disabledStageReason || textureEditing) return;
        stageRunPending.current = true;
        setLaunching(true);
        setLaunchFeedback(null);
        try {
          const result = await runStage(stageId, stagesDirty, form, pinnedSource?.choice);
          const failed = result.status === "failed" || result.status === "cancelled";
          setLaunchFeedback({
            failed,
            key: launchKey,
            message: result.message ?? (failed ? "Could not run the selected stage." : "Stage requested."),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not run the selected stage.";
          setLaunchFeedback({ failed: true, key: launchKey, message });
        } finally {
          stageRunPending.current = false;
          setLaunching(false);
        }
      },
    } : undefined;
  const commonProps = {
    authoringBusy: state.authoringBusy,
    algorithmsAvailable: runtimeStatus?.capabilities.algorithms_available,
    authoringFeedback:
      state.authoringFeedbackScope === "stages" ? state.authoringFeedback : null,
    draft,
    draftIndex: selectedIndex,
    demagEnabled: state.globalDraft.demagEnabled,
    onCommit: () => { if (!textureEditing) void commitStageDrafts(); },
    pipelineDraftDirty: stagesDirty,
    onUpdateDraft: (patch: Partial<(typeof state.stageDrafts)[number]>) => {
      if (draft?.pipelineNodeId && (!isEditablePipelineStage(draft) || draft.pipelineNodeId !== stageId)) return;
      dispatch({ type: "updateStageDraft", index: selectedIndex, patch });
    },
    pipelineDrafts: state.stageDrafts,
    requestedBackend: model.requested.backend,
    requestedDevice: model.requested.device,
    requestedMode: model.requested.mode,
    scene: scene.data ?? null,
    runRuntimeCommand: runCommand,
    runtimeCommandDisabledReason: commandDisabledReason,
    stage: model.selectedStage,
    stageLaunch,
    stageExecutionRevision: stageExecution.data?.revision ?? null,
    textureAuthoring,
    validation: textureEditBlockReason
      ? [...validation, { message: textureEditBlockReason, severity: "error" as const }]
      : validation,
  };

  return (
    <div
      className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group"
      data-scene-has-payload={sceneHasPayload}
      data-scene-revision={sceneRevision ?? ""}
      data-scene-stage-count={sceneStageCount}
      data-scene-status={scene.status}
      data-stage-draft-count={state.stageDrafts.length}
    >
      {inspectorKind === "antenna_field_solve" ? (
        <AntennaFieldSolveStageInspector
          {...commonProps}
          expectedKind="antenna_field_solve"
          kindLabel="Antenna Field Solve"
        />
      ) : inspectorKind === "unsupported" ? (
        <UnsupportedStageInspector
          {...commonProps}
          expectedKind="unsupported"
          kindLabel="Unsupported"
        />
      ) : inspectorKind === "add_field_drive" ? (
        <AddFieldDriveStageInspector
          {...commonProps}
          expectedKind="add_field_drive"
          kindLabel="Add Field Drive"
        />
      ) : inspectorKind === "table_autosave" ? (
        <TableAutosaveStageInspector
          {...commonProps}
          expectedKind="table_autosave"
          kindLabel="Table Autosave"
        />
      ) : inspectorKind === "autosave" ? (
        <AutosaveStageInspector
          {...commonProps}
          expectedKind="autosave"
          kindLabel="Autosave"
        />
      ) : inspectorKind === "fft_response" ? (
        <FftResponseStageInspector
          {...commonProps}
          expectedKind="fft_response"
          kindLabel="FFT Response"
        />
      ) : inspectorKind === "run" ? (
        <RunStageInspector
          {...commonProps}
          expectedKind="run"
          kindLabel="Run"
        />
      ) : inspectorKind === "change_device" ? (
        <ChangeDeviceStageInspector
          {...commonProps}
          expectedKind="change_device"
          kindLabel="Change Device"
        />
      ) : inspectorKind === "hysteresis" ? (
        <HysteresisStageInspector
          {...commonProps}
          expectedKind="hysteresis"
          kindLabel="Hysteresis"
          view={hysteresisView}
        />
      ) : inspectorKind === "eigenmodes" ? (
        <EigenmodesStageInspector
          {...commonProps}
          authoringView={frequencyDomainAuthoringView}
          expectedKind="eigenmodes"
          kindLabel="Eigenmodes"
        />
      ) : inspectorKind === "frequency_response" ? (
        <FrequencyResponseStageInspector
          {...commonProps}
          authoringView={frequencyDomainAuthoringView}
          expectedKind="frequency_response"
          kindLabel="Frequency Response"
        />
      ) : inspectorKind === "save_state" ? (
        <SaveStateStageInspector
          {...commonProps}
          expectedKind="save_state"
          kindLabel="Save State"
        />
      ) : (
        <RelaxStageInspector
          {...commonProps}
          expectedKind="relax"
          kindLabel="Relax"
        />
      )}
    </div>
  );
}

function makeFrequencyDomainStagePanel(displayName: string) {
  function FrequencyDomainStagePanel(props: InspectorPanelProps) {
    return <StudyStageInspectorRouter {...props} />;
  }
  FrequencyDomainStagePanel.displayName = displayName;
  return FrequencyDomainStagePanel;
}

export const EigenmodesStageOverviewInspectorPanel =
  makeFrequencyDomainStagePanel("EigenmodesStageOverviewInspectorPanel");
export const EigenmodesSetupStageInspectorPanel =
  makeFrequencyDomainStagePanel("EigenmodesSetupStageInspectorPanel");
export const EigenmodesCalculationModeStageInspectorPanel =
  makeFrequencyDomainStagePanel("EigenmodesCalculationModeStageInspectorPanel");
export const EigenmodesEquilibriumStageInspectorPanel =
  makeFrequencyDomainStagePanel("EigenmodesEquilibriumStageInspectorPanel");
export const EigenmodesOperatorStageInspectorPanel =
  makeFrequencyDomainStagePanel("EigenmodesOperatorStageInspectorPanel");
export const EigenmodesBoundaryStageInspectorPanel =
  makeFrequencyDomainStagePanel("EigenmodesBoundaryStageInspectorPanel");
export const EigenmodesPeriodicPairsStageInspectorPanel =
  makeFrequencyDomainStagePanel("EigenmodesPeriodicPairsStageInspectorPanel");
export const EigenmodesKPathStageInspectorPanel =
  makeFrequencyDomainStagePanel("EigenmodesKPathStageInspectorPanel");
export const EigenmodesSolverStageInspectorPanel =
  makeFrequencyDomainStagePanel("EigenmodesSolverStageInspectorPanel");
export const EigenmodesOutputsStageInspectorPanel =
  makeFrequencyDomainStagePanel("EigenmodesOutputsStageInspectorPanel");
export const EigenmodesDiagnosticsStageInspectorPanel =
  makeFrequencyDomainStagePanel("EigenmodesDiagnosticsStageInspectorPanel");

export const FrequencyResponseStageOverviewInspectorPanel =
  makeFrequencyDomainStagePanel("FrequencyResponseStageOverviewInspectorPanel");
export const FrequencyResponseSetupStageInspectorPanel =
  makeFrequencyDomainStagePanel("FrequencyResponseSetupStageInspectorPanel");
export const FrequencyResponseCalculationModeStageInspectorPanel =
  makeFrequencyDomainStagePanel(
    "FrequencyResponseCalculationModeStageInspectorPanel",
  );
export const FrequencyResponseEquilibriumStageInspectorPanel =
  makeFrequencyDomainStagePanel("FrequencyResponseEquilibriumStageInspectorPanel");
export const FrequencyResponseOperatorStageInspectorPanel =
  makeFrequencyDomainStagePanel("FrequencyResponseOperatorStageInspectorPanel");
export const FrequencyResponseBoundaryStageInspectorPanel =
  makeFrequencyDomainStagePanel("FrequencyResponseBoundaryStageInspectorPanel");
export const FrequencyResponsePeriodicPairsStageInspectorPanel =
  makeFrequencyDomainStagePanel(
    "FrequencyResponsePeriodicPairsStageInspectorPanel",
  );
export const FrequencyResponseKGridStageInspectorPanel =
  makeFrequencyDomainStagePanel("FrequencyResponseKGridStageInspectorPanel");
export const FrequencyResponseExcitationStageInspectorPanel =
  makeFrequencyDomainStagePanel("FrequencyResponseExcitationStageInspectorPanel");
export const FrequencyResponseSweepStageInspectorPanel =
  makeFrequencyDomainStagePanel("FrequencyResponseSweepStageInspectorPanel");
export const FrequencyResponseSolverStageInspectorPanel =
  makeFrequencyDomainStagePanel("FrequencyResponseSolverStageInspectorPanel");
export const FrequencyResponseOutputsStageInspectorPanel =
  makeFrequencyDomainStagePanel("FrequencyResponseOutputsStageInspectorPanel");
export const FrequencyResponseDiagnosticsStageInspectorPanel =
  makeFrequencyDomainStagePanel("FrequencyResponseDiagnosticsStageInspectorPanel");

export function resolveStudyStageInspectorKind(
  selectionKind: InspectorPanelProps["selection"]["kind"],
  selectedStageKind: string | null | undefined,
) {
  if (selectionKind === "study.stage.antenna_field_solve") return "antenna_field_solve";
  if (selectionKind === "study.stage.action" && selectedStageKind) {
    return selectedStageKind;
  }
  if (selectionKind === "study.stage.add_field_drive") return "add_field_drive";
  if (selectionKind === "study.stage.table_autosave") return "table_autosave";
  if (selectionKind === "study.stage.autosave") return "autosave";
  if (selectionKind === "study.stage.fft_response") return "fft_response";
  if (selectionKind === "study.stage.run") return "run";
  if (selectionKind === "study.stage.change_device") return "change_device";
  if (selectionKind === "study.stage.hysteresis") return "hysteresis";
  if (selectionKind?.startsWith("study.stage.eigenmodes")) return "eigenmodes";
  if (selectionKind?.startsWith("study.stage.frequency_response")) {
    return "frequency_response";
  }
  if (selectionKind === "study.stage.save_state") return "save_state";
  return "relax";
}

export function resolveFrequencyDomainAuthoringView(
  selectionKind: InspectorPanelProps["selection"]["kind"],
): FrequencyDomainAuthoringView {
  const detail = selectionKind?.split(".").at(-1);
  if (detail === "calculation_mode") return "calculation_mode";
  if (detail === "setup") return "setup";
  if (detail === "equilibrium") return "equilibrium";
  if (detail === "operator") return "operator";
  if (detail === "boundary") return "boundary";
  if (detail === "periodic_pairs") return "periodic_pairs";
  if (detail === "k_path") return "k_path";
  if (detail === "k_grid") return "k_grid";
  if (detail === "excitation") return "excitation";
  if (detail === "sweep") return "sweep";
  if (detail === "solver") return "solver";
  if (detail === "outputs") return "outputs";
  if (detail === "diagnostics") return "diagnostics";
  return "overview";
}
