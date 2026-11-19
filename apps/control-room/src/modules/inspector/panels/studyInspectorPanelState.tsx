"use client";

import type { SessionImportInspectResponse } from "@/kernel/api/apiTypes";
import { createStudyGlobalDraft, type StudyGlobalDraft } from "./StudyGlobalAuthoringModel";
import {
  createDefaultStudyStageDraft,
  type StudyStageDraft,
  type StudyStageDraftKind,
} from "./StudyStageAuthoringModel";
import {
  clampIndex,
  numericSceneRevision,
} from "./studyInspectorShared";

interface StudyInspectorPanelState {
  authoringBusy: boolean;
  authoringDraftsInitialized: boolean;
  authoringFeedback: {
    kind: "error" | "success" | "warning";
    message: string;
    sceneRevision?: number;
  } | null;
  authoringFeedbackScope: "global" | "stages" | null;
  baselineGlobalDraft: StudyGlobalDraft;
  baselineStageDrafts: StudyStageDraft[];
  draftSceneRevision: number | string | null;
  draftSceneSignature: string;
  globalDraft: StudyGlobalDraft;
  importDialogOpen: boolean;
  importError: string | null;
  importFileName: string | null;
  importFmsBase64: string | null;
  importInspection: SessionImportInspectResponse["inspection"] | null;
  importInspecting: boolean;
  importRestoreMode: string;
  restoreDialogOpen: boolean;
  selectedDraftIndex: number;
  selectedCommandId: string | null;
  selectedRestoreCheckpointId: string | null;
  stageDrafts: StudyStageDraft[];
}

type StudyInspectorPanelAction =
  | {
      type: "resetStageDrafts";
      drafts: StudyStageDraft[];
      globalDraft: StudyGlobalDraft;
      preserveGlobalDraft?: StudyGlobalDraft;
      preserveStageDrafts?: StudyStageDraft[];
      revision: number | string | null;
      selectedIndex: number;
      signature: string;
    }
  | { type: "acceptGlobalDraft" }
  | { type: "acceptStageDrafts"; submittedDrafts: StudyStageDraft[]; committedPipelineDraft?: StudyStageDraft }
  | { type: "revertGlobalDraft" }
  | { type: "revertStageDrafts" }
  | {
      type: "updateGlobalDraft";
      patch: Partial<StudyGlobalDraft>;
    }
  | { type: "selectStageDraft"; index: number }
  | { type: "clearStageAuthoringFeedback" }
  | {
      type: "updateStageDraft";
      index: number;
      patch: Partial<StudyStageDraft>;
    }
  | { type: "addStageDraft"; kind: StudyStageDraftKind }
  | { type: "duplicateStageDraft"; index: number }
  | { type: "removeStageDraft"; index: number }
  | { type: "moveStageDraft"; direction: -1 | 1; index: number }
  | { type: "setAuthoringBusy"; busy: boolean }
  | {
      type: "setAuthoringFeedback";
      feedback: StudyInspectorPanelState["authoringFeedback"];
      scope: StudyInspectorPanelState["authoringFeedbackScope"];
    }
  | { type: "setImportDialogOpen"; open: boolean }
  | { type: "setImportRestoreMode"; mode: string }
  | { type: "setRestoreDialogOpen"; open: boolean }
  | { type: "setSelectedCommandId"; commandId: string | null }
  | { type: "setSelectedRestoreCheckpointId"; checkpointId: string | null }
  | { type: "prepareImportFile"; fileName: string | null }
  | {
      type: "importInspectSuccess";
      fmsBase64: string;
      inspection: SessionImportInspectResponse["inspection"];
    }
  | { type: "importInspectFailure"; message: string };

export const STUDY_INSPECTOR_INITIAL_STATE: StudyInspectorPanelState = {
  authoringBusy: false,
  authoringDraftsInitialized: false,
  authoringFeedback: null,
  authoringFeedbackScope: null,
  baselineGlobalDraft: createStudyGlobalDraft(null),
  baselineStageDrafts: [],
  draftSceneRevision: null,
  draftSceneSignature: "",
  globalDraft: createStudyGlobalDraft(null),
  importDialogOpen: false,
  importError: null,
  importFileName: null,
  importFmsBase64: null,
  importInspection: null,
  importInspecting: false,
  importRestoreMode: "resume",
  restoreDialogOpen: false,
  selectedDraftIndex: 0,
  selectedCommandId: null,
  selectedRestoreCheckpointId: null,
  stageDrafts: [],
};

export function studyInspectorPanelReducer(
  state: StudyInspectorPanelState,
  action: StudyInspectorPanelAction,
): StudyInspectorPanelState {
  switch (action.type) {
    case "resetStageDrafts": {
      if (
        state.authoringDraftsInitialized &&
        state.draftSceneRevision === action.revision &&
        state.draftSceneSignature === action.signature
      ) {
        return state;
      }
      const preserveAcknowledgedStageSave =
        state.authoringFeedbackScope === "stages" &&
        state.selectedDraftIndex === action.selectedIndex &&
        action.preserveStageDrafts === undefined &&
        state.authoringFeedback?.kind === "success" &&
        state.authoringFeedback.sceneRevision !== undefined &&
        numericSceneRevision(action.revision) === state.authoringFeedback.sceneRevision;
      return {
        ...state,
        authoringBusy: false,
        authoringDraftsInitialized: true,
        authoringFeedback: preserveAcknowledgedStageSave ? state.authoringFeedback : null,
        authoringFeedbackScope: preserveAcknowledgedStageSave ? "stages" : null,
        baselineGlobalDraft: action.globalDraft,
        baselineStageDrafts: action.preserveStageDrafts?.some((draft) => draft.pipelineNodeId)
          ? state.baselineStageDrafts
          : action.drafts,
        draftSceneRevision: action.revision,
        draftSceneSignature: action.signature,
        globalDraft: action.preserveGlobalDraft ?? action.globalDraft,
        selectedDraftIndex:
          action.preserveStageDrafts === undefined
            ? action.selectedIndex
            : clampIndex(state.selectedDraftIndex, action.preserveStageDrafts),
        stageDrafts: action.preserveStageDrafts ?? action.drafts,
      };
    }
    case "clearStageAuthoringFeedback":
      if (state.authoringFeedbackScope !== "stages" || state.authoringFeedback === null) return state;
      return { ...state, authoringFeedback: null, authoringFeedbackScope: null };
    case "acceptGlobalDraft":
      return { ...state, baselineGlobalDraft: state.globalDraft };
    case "acceptStageDrafts": {
      const committed = action.committedPipelineDraft;
      if (!committed) return { ...state, baselineStageDrafts: action.submittedDrafts };
      const submitted = action.submittedDrafts.find((draft) => draft.pipelineNodeId === committed.pipelineNodeId);
      return {
        ...state,
        baselineStageDrafts: action.submittedDrafts.map((draft) =>
          draft === submitted ? committed : draft,
        ),
        stageDrafts: state.stageDrafts.map((draft) => {
          if (draft.pipelineNodeId !== committed.pipelineNodeId) return draft;
          if (JSON.stringify(draft) === JSON.stringify(submitted)) return committed;
          return { ...draft, rawStage: committed.rawStage };
        }),
      };
    }
    case "revertGlobalDraft":
      return {
        ...state,
        authoringFeedback: null,
        authoringFeedbackScope: null,
        globalDraft: state.baselineGlobalDraft,
      };
    case "revertStageDrafts":
      return {
        ...state,
        authoringFeedback: null,
        authoringFeedbackScope: null,
        selectedDraftIndex: clampIndex(
          state.selectedDraftIndex,
          state.baselineStageDrafts,
        ),
        stageDrafts: state.baselineStageDrafts,
        authoringDraftsInitialized: state.baselineStageDrafts.some((draft) => draft.pipelineNodeId)
          ? false
          : state.authoringDraftsInitialized,
      };
    case "updateGlobalDraft":
      return {
        ...state,
        authoringFeedback: null,
        authoringFeedbackScope: null,
        globalDraft: { ...state.globalDraft, ...action.patch },
      };
    case "selectStageDraft": {
      const selectedDraftIndex = clampIndex(action.index, state.stageDrafts);
      if (selectedDraftIndex === state.selectedDraftIndex) return state;
      return state.authoringFeedbackScope === "stages"
        ? {
            ...state,
            authoringFeedback: null,
            authoringFeedbackScope: null,
            selectedDraftIndex,
          }
        : { ...state, selectedDraftIndex };
    }
    case "updateStageDraft":
      return {
        ...state,
        authoringFeedback: null,
        authoringFeedbackScope: null,
        stageDrafts: state.stageDrafts.map((draft, index) =>
          index === action.index ? { ...draft, ...action.patch } : draft,
        ),
      };
    case "addStageDraft": {
      const draft = createDefaultStudyStageDraft(
        action.kind,
        state.stageDrafts.length,
      );
      return {
        ...state,
        authoringFeedback: null,
        authoringFeedbackScope: null,
        selectedDraftIndex: state.stageDrafts.length,
        stageDrafts: [...state.stageDrafts, draft],
      };
    }
    case "duplicateStageDraft": {
      const source = state.stageDrafts[action.index];
      if (!source) return state;
      // The immutable definition reference cannot be renamed into a second solve.
      if (source.kind === "antenna_field_solve") return state;
      const draft = {
        ...source,
        stageId: `${source.stageId || source.kind}-copy`,
      };
      const stageDrafts = [...state.stageDrafts];
      stageDrafts.splice(action.index + 1, 0, draft);
      return {
        ...state,
        authoringFeedback: null,
        authoringFeedbackScope: null,
        selectedDraftIndex: action.index + 1,
        stageDrafts,
      };
    }
    case "removeStageDraft": {
      const stageDrafts = state.stageDrafts.filter(
        (_, index) => index !== action.index,
      );
      return {
        ...state,
        authoringFeedback: null,
        authoringFeedbackScope: null,
        selectedDraftIndex: clampIndex(action.index, stageDrafts),
        stageDrafts,
      };
    }
    case "moveStageDraft": {
      const targetIndex = action.index + action.direction;
      if (
        action.index < 0 ||
        targetIndex < 0 ||
        action.index >= state.stageDrafts.length ||
        targetIndex >= state.stageDrafts.length
      ) {
        return state;
      }
      const stageDrafts = [...state.stageDrafts];
      const [draft] = stageDrafts.splice(action.index, 1);
      stageDrafts.splice(targetIndex, 0, draft);
      return {
        ...state,
        authoringFeedback: null,
        authoringFeedbackScope: null,
        selectedDraftIndex: targetIndex,
        stageDrafts,
      };
    }
    case "setAuthoringBusy":
      return { ...state, authoringBusy: action.busy };
    case "setAuthoringFeedback":
      return {
        ...state,
        authoringFeedback: action.feedback,
        authoringFeedbackScope: action.scope,
      };
    case "setImportDialogOpen":
      return { ...state, importDialogOpen: action.open };
    case "setImportRestoreMode":
      return { ...state, importRestoreMode: action.mode };
    case "setRestoreDialogOpen":
      return { ...state, restoreDialogOpen: action.open };
    case "setSelectedCommandId":
      return { ...state, selectedCommandId: action.commandId };
    case "setSelectedRestoreCheckpointId":
      return {
        ...state,
        selectedRestoreCheckpointId: action.checkpointId,
      };
    case "prepareImportFile":
      return {
        ...state,
        importError: null,
        importFileName: action.fileName,
        importFmsBase64: null,
        importInspection: null,
        importInspecting: action.fileName !== null,
      };
    case "importInspectSuccess":
      return {
        ...state,
        importError: null,
        importFmsBase64: action.fmsBase64,
        importInspection: action.inspection,
        importInspecting: false,
        importRestoreMode: action.inspection.restore_class ?? "resume",
      };
    case "importInspectFailure":
      return {
        ...state,
        importError: action.message,
        importInspecting: false,
      };
  }
}
