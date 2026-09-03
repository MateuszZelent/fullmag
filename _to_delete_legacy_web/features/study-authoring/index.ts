export { useAuthoringStore, selectSceneDraft, selectModelBuilderGraph, selectSyncStatus, selectIsDirty, selectSelectedObjectId, selectSelectedEntityId, selectFocusedEntityId, selectMeshEntityViewState, selectValidationErrors } from "./store/useAuthoringStore";
export type { AuthoringState, DraftSyncStatus, DraftValidationError } from "./model/sceneDraft.types";
export { DraftSyncController } from "./sync/DraftSyncController";
export type { DraftCommitEntry, DraftSyncCallbacks, DraftSyncApi } from "./sync/DraftSyncController";
export { remoteSceneToDraft } from "./adapters/remoteSceneToDraft";
export { draftSignature, draftsEqual } from "./adapters/draftToSceneDocument";
export { draftToModelTree } from "./adapters/draftToModelTree";
export type { ModelTreeNode } from "./adapters/draftToModelTree";
export * from "./commands/index";
export { applyPipelineCommand } from "./commands/pipelineCommands";
export type { StudyPipelineCommand } from "./commands/pipelineCommands";
export {
  registerStageTemplate,
  getStageTemplate,
  getAllStageTemplates,
  getStageTemplatesByCategory,
  stageLabel,
  stageIconToken,
} from "./registry/stageTemplateRegistry";
export type { StageTemplateEntry, StageCategory } from "./registry/stageTemplateRegistry";

// Study authoring dialogs
export { AddStudyDialog } from "./components/AddStudyDialog";
export type { AddStudyDialogProps } from "./components/AddStudyDialog";
export { AddStageDialog } from "./components/AddStageDialog";
export type { AddStageDialogProps } from "./components/AddStageDialog";

// Python projection types
export type {
  StagePythonProjection,
  PythonArgValue,
  StudyPythonProjection,
  WorkspacePythonProjection,
  UniverseSetupProjection,
} from "./model/pythonProjection.types";
