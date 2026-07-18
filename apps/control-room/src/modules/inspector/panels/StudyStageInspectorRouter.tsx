"use client";

import { useCallback } from "react";

import type { InspectorPanelProps } from "../inspectorTypes";
import { useRegisterInspectorEditSession } from "../InspectorEditSession";

import { validateStudyStageDraft } from "./StudyStageAuthoringModel";
import { useStudyInspectorPanelController } from "./StudyInspectorPanel";
import { ChangeDeviceStageInspector } from "./stages/ChangeDeviceStageInspector";
import { AddFieldDriveStageInspector } from "./stages/AddFieldDriveStageInspector";
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
import type { FrequencyDomainAuthoringView } from "./stages/StageInspectorFrame";
import { validateStudyWorkflow } from "./stages/studyWorkflowState";

export function StudyStageInspectorRouter({ selection }: InspectorPanelProps) {
  const {
    commandDisabledReason,
    commitStageDrafts,
    dispatch,
    model,
    runtimeStatus,
    runCommand,
    scene,
    sceneHasPayload,
    sceneRevision,
    sceneStageCount,
    stageExecution,
    state,
  } = useStudyInspectorPanelController(selection);
  const selectedIndex = model.selectedStage?.index ?? state.selectedDraftIndex;
  const draft = state.stageDrafts[selectedIndex] ?? null;
  const localValidation = draft
    ? validateStudyStageDraft(draft, {
        algorithmsAvailable: runtimeStatus?.capabilities.algorithms_available,
        backend: model.requested.backend,
        demagEnabled: state.globalDraft.demagEnabled,
        device: model.requested.device,
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
    () => dispatch({ type: "revertStageDrafts" }),
    [dispatch],
  );
  useRegisterInspectorEditSession(
    "staged",
    state.authoringBusy,
    JSON.stringify(state.stageDrafts) !==
      JSON.stringify(state.baselineStageDrafts),
    !allStageValidation.some((issue) => issue.severity === "error"),
    state.authoringBusy ? "Study stage changes are being saved." : undefined,
    commitStageDrafts,
    resetStageDrafts,
  );
  const selectedStageKind = model.selectedStage?.kind ?? draft?.kind ?? null;
  const inspectorKind = resolveStudyStageInspectorKind(selection.kind, selectedStageKind);
  const frequencyDomainAuthoringView =
    resolveFrequencyDomainAuthoringView(selection.kind);
  const hysteresisView =
    inspectorKind === "hysteresis"
      ? resolveHysteresisInspectorView(selection.nodeId)
      : "overview";
  const commonProps = {
    authoringBusy: state.authoringBusy,
    algorithmsAvailable: runtimeStatus?.capabilities.algorithms_available,
    authoringFeedback:
      state.authoringFeedbackScope === "stages" ? state.authoringFeedback : null,
    draft,
    draftIndex: selectedIndex,
    demagEnabled: state.globalDraft.demagEnabled,
    onCommit: () => void commitStageDrafts(),
    onUpdateDraft: (patch: Partial<(typeof state.stageDrafts)[number]>) =>
      dispatch({ type: "updateStageDraft", index: selectedIndex, patch }),
    pipelineDrafts: state.stageDrafts,
    requestedBackend: model.requested.backend,
    requestedDevice: model.requested.device,
    requestedMode: model.requested.mode,
    scene: scene.data ?? null,
    runRuntimeCommand: runCommand,
    runtimeCommandDisabledReason: commandDisabledReason,
    stage: model.selectedStage,
    stageExecutionRevision: stageExecution.data?.revision ?? null,
    validation,
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
      {inspectorKind === "unsupported" ? (
        <UnsupportedStageInspector
          {...commonProps}
          expectedKind="unsupported"
          kindLabel="Unsupported"
        />
      ) : inspectorKind === "add_field_drive" ? (
        <AddFieldDriveStageInspector
          {...commonProps}
          expectedKind="add_field_drive"
          kindLabel="Add Antenna"
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
