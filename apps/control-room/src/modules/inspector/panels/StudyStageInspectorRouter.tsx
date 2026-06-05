"use client";

import { Accordion } from "@/shared/ui/Accordion";

import type { InspectorPanelProps } from "../inspectorTypes";

import { validateStudyStageDraft } from "./StudyStageAuthoringModel";
import { useStudyInspectorPanelController } from "./StudyInspectorPanel";
import { EigenmodesStageInspector } from "./stages/EigenmodesStageInspector";
import { FrequencyResponseStageInspector } from "./stages/FrequencyResponseStageInspector";
import { HysteresisStageInspector } from "./stages/HysteresisStageInspector";
import { RelaxStageInspector } from "./stages/RelaxStageInspector";
import { RunStageInspector } from "./stages/RunStageInspector";
import { SaveStateStageInspector } from "./stages/SaveStateStageInspector";

export function StudyStageInspectorRouter({ selection }: InspectorPanelProps) {
  const {
    commitStageDrafts,
    dispatch,
    model,
    scene,
    sceneHasPayload,
    sceneRevision,
    sceneStageCount,
    stageExecution,
    state,
  } = useStudyInspectorPanelController(selection);
  const selectedIndex = model.selectedStage?.index ?? state.selectedDraftIndex;
  const draft = state.stageDrafts[selectedIndex] ?? null;
  const validation = draft ? validateStudyStageDraft(draft) : [];
  const commonProps = {
    authoringBusy: state.authoringBusy,
    authoringFeedback:
      state.authoringFeedbackScope === "stages" ? state.authoringFeedback : null,
    draft,
    draftIndex: selectedIndex,
    onCommit: () => void commitStageDrafts(),
    onUpdateDraft: (patch: Partial<(typeof state.stageDrafts)[number]>) =>
      dispatch({ type: "updateStageDraft", index: selectedIndex, patch }),
    stage: model.selectedStage,
    stageExecutionRevision: stageExecution.data?.revision ?? null,
    validation,
  };

  return (
    <Accordion
      className="fm-inspector-panel"
      data-scene-has-payload={sceneHasPayload}
      data-scene-revision={sceneRevision ?? ""}
      data-scene-stage-count={sceneStageCount}
      data-scene-status={scene.status}
      data-stage-draft-count={state.stageDrafts.length}
      type="multiple"
      defaultValue={[
        "identity",
        "authoring",
        "telemetry",
        "relax-results",
        "run-results",
        "hysteresis-results",
        "eigenmodes-results",
        "frequency-response-results",
        "save-state-results",
      ]}
    >
      {selection.kind === "study.stage.run" ? (
        <RunStageInspector
          {...commonProps}
          expectedKind="run"
          kindLabel="Run"
        />
      ) : selection.kind === "study.stage.hysteresis" ? (
        <HysteresisStageInspector
          {...commonProps}
          expectedKind="hysteresis"
          kindLabel="Hysteresis"
        />
      ) : selection.kind === "study.stage.eigenmodes" ? (
        <EigenmodesStageInspector
          {...commonProps}
          expectedKind="eigenmodes"
          kindLabel="Eigenmodes"
        />
      ) : selection.kind === "study.stage.frequency_response" ? (
        <FrequencyResponseStageInspector
          {...commonProps}
          expectedKind="frequency_response"
          kindLabel="Frequency Response"
        />
      ) : selection.kind === "study.stage.save_state" ? (
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
    </Accordion>
  );
}
