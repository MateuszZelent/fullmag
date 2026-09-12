/**
 * Layer C: Authoring Store
 *
 * Owns:
 * - SceneDraft (the local editable scene)
 * - Model builder graph (derived from draft)
 * - Selection state for the builder/tree
 * - Dirty state and sync status
 * - Validation errors
 * - Pending commit queue
 *
 * Does NOT own:
 * - Live telemetry (transport layer)
 * - Viewport interaction state (viewport store)
 * - Panel layout (shell store)
 * - Backend connection (session runtime store)
 */

import { create } from "zustand";
import type {
  SceneDocument,
  ModelBuilderGraphV2,
  MeshEntityViewStateMap,
  ScriptBuilderStageState,
  ScriptBuilderGeometryEntry,
  ScriptBuilderCurrentModuleEntry,
  ScriptBuilderExcitationAnalysisEntry,
  ScriptBuilderUniverseState,
  StudyPipelineDocumentState,
  VisualizationPreset,
  VisualizationPresetRef,
} from "@/lib/session/types";
import type { SolverSettingsState } from "@/components/panels/SolverSettingsPanel";
import type { MeshOptionsState } from "@/lib/mesh/options";
import type { DraftSyncStatus, DraftValidationError } from "../model/sceneDraft.types";

interface AuthoringStoreState {
  /** Core draft */
  sceneDraft: SceneDocument | null;
  modelBuilderGraph: ModelBuilderGraphV2 | null;

  /** Solver & mesh */
  solverSettings: SolverSettingsState | null;
  meshOptions: MeshOptionsState | null;

  /** Study pipeline */
  studyStages: ScriptBuilderStageState[];
  studyPipeline: StudyPipelineDocumentState | null;

  /** Script builder domain data */
  scriptBuilderDemagRealization: string | null;
  scriptBuilderUniverse: ScriptBuilderUniverseState | null;
  scriptBuilderGeometries: ScriptBuilderGeometryEntry[];
  scriptBuilderCurrentModules: ScriptBuilderCurrentModuleEntry[];
  scriptBuilderExcitationAnalysis: ScriptBuilderExcitationAnalysisEntry | null;

  /** Runtime selection */
  requestedRuntimeSelection: {
    requested_backend: string;
    requested_device: string;
    requested_precision: string;
    requested_mode: string;
    requested_cpu_threads: number | null;
  };

  /** Selection / focus */
  selectedSidebarNodeId: string | null;
  selectedObjectId: string | null;
  selectedEntityId: string | null;
  focusedEntityId: string | null;

  /** Per-entity view state */
  meshEntityViewState: MeshEntityViewStateMap;

  /** Visualization */
  visualizationProjectPresets: VisualizationPreset[];
  visualizationLocalPresets: VisualizationPreset[];
  activeVisualizationPresetRef: VisualizationPresetRef | null;

  /** Sync */
  syncStatus: DraftSyncStatus;
  syncError: string | null;
  isDirty: boolean;
  validationErrors: DraftValidationError[];
  hydratedSessionKey: string | null;

  /** Actions */
  setSceneDraft: (draft: SceneDocument | null) => void;
  setModelBuilderGraph: (graph: ModelBuilderGraphV2 | null) => void;
  applyCommand: (
    command: (draft: SceneDocument) => SceneDocument,
  ) => void;
  setSolverSettings: (settings: SolverSettingsState) => void;
  setMeshOptions: (options: MeshOptionsState) => void;
  setStudyStages: (stages: ScriptBuilderStageState[]) => void;
  setStudyPipeline: (pipeline: StudyPipelineDocumentState | null) => void;
  setScriptBuilderDemagRealization: (value: string | null) => void;
  setScriptBuilderUniverse: (value: ScriptBuilderUniverseState | null) => void;
  setScriptBuilderGeometries: (value: ScriptBuilderGeometryEntry[]) => void;
  setScriptBuilderCurrentModules: (value: ScriptBuilderCurrentModuleEntry[]) => void;
  setScriptBuilderExcitationAnalysis: (value: ScriptBuilderExcitationAnalysisEntry | null) => void;
  setRequestedRuntimeSelection: (value: {
    requested_backend: string;
    requested_device: string;
    requested_precision: string;
    requested_mode: string;
    requested_cpu_threads: number | null;
  }) => void;
  setSelectedSidebarNodeId: (id: string | null) => void;
  setSelectedObjectId: (id: string | null) => void;
  setSelectedEntityId: (id: string | null) => void;
  setFocusedEntityId: (id: string | null) => void;
  setMeshEntityViewState: (state: MeshEntityViewStateMap) => void;
  setActiveVisualizationPresetRef: (ref: VisualizationPresetRef | null) => void;
  setSyncStatus: (status: DraftSyncStatus, error?: string | null) => void;
  setIsDirty: (dirty: boolean) => void;
  setHydratedSessionKey: (key: string | null) => void;

  /** Hydrate from remote */
  hydrateFromRemote: (
    draft: SceneDocument,
    graph: ModelBuilderGraphV2 | null,
    sessionKey: string,
  ) => void;

  /** Reset on session change */
  resetAuthoring: () => void;
}

const INITIAL_STATE = {
  sceneDraft: null,
  modelBuilderGraph: null,
  solverSettings: null,
  meshOptions: null,
  studyStages: [] as ScriptBuilderStageState[],
  studyPipeline: null,
  scriptBuilderDemagRealization: null,
  scriptBuilderUniverse: null,
  scriptBuilderGeometries: [] as ScriptBuilderGeometryEntry[],
  scriptBuilderCurrentModules: [] as ScriptBuilderCurrentModuleEntry[],
  scriptBuilderExcitationAnalysis: null,
  requestedRuntimeSelection: {
    requested_backend: "auto",
    requested_device: "auto",
    requested_precision: "double",
    requested_mode: "strict",
    requested_cpu_threads: null,
  },
  selectedSidebarNodeId: null,
  selectedObjectId: null,
  selectedEntityId: null,
  focusedEntityId: null,
  meshEntityViewState: {} as MeshEntityViewStateMap,
  visualizationProjectPresets: [] as VisualizationPreset[],
  visualizationLocalPresets: [] as VisualizationPreset[],
  activeVisualizationPresetRef: null,
  syncStatus: "idle" as DraftSyncStatus,
  syncError: null,
  isDirty: false,
  validationErrors: [] as DraftValidationError[],
  hydratedSessionKey: null,
};

export const useAuthoringStore = create<AuthoringStoreState>((set, get) => ({
  ...INITIAL_STATE,

  setSceneDraft: (draft) => set({ sceneDraft: draft, isDirty: true }),
  setModelBuilderGraph: (graph) => set({ modelBuilderGraph: graph }),

  applyCommand: (command) => {
    const { sceneDraft } = get();
    if (!sceneDraft) return;
    const nextDraft = command(sceneDraft);
    set({ sceneDraft: nextDraft, isDirty: true });
  },

  setSolverSettings: (settings) => set({ solverSettings: settings, isDirty: true }),
  setMeshOptions: (options) => set({ meshOptions: options, isDirty: true }),
  setStudyStages: (stages) => set({ studyStages: stages, isDirty: true }),
  setStudyPipeline: (pipeline) => set({ studyPipeline: pipeline, isDirty: true }),
  setScriptBuilderDemagRealization: (value) => set({ scriptBuilderDemagRealization: value, isDirty: true }),
  setScriptBuilderUniverse: (value) => set({ scriptBuilderUniverse: value, isDirty: true }),
  setScriptBuilderGeometries: (value) => set({ scriptBuilderGeometries: value, isDirty: true }),
  setScriptBuilderCurrentModules: (value) => set({ scriptBuilderCurrentModules: value, isDirty: true }),
  setScriptBuilderExcitationAnalysis: (value) => set({ scriptBuilderExcitationAnalysis: value, isDirty: true }),
  setRequestedRuntimeSelection: (value) => set({ requestedRuntimeSelection: value, isDirty: true }),
  setSelectedSidebarNodeId: (id) => set({ selectedSidebarNodeId: id }),
  setSelectedObjectId: (id) => set({ selectedObjectId: id }),
  setSelectedEntityId: (id) => set({ selectedEntityId: id }),
  setFocusedEntityId: (id) => set({ focusedEntityId: id }),
  setMeshEntityViewState: (state) => set({ meshEntityViewState: state }),
  setActiveVisualizationPresetRef: (ref) => set({ activeVisualizationPresetRef: ref }),
  setSyncStatus: (status, error = null) => set({ syncStatus: status, syncError: error }),
  setIsDirty: (dirty) => set({ isDirty: dirty }),
  setHydratedSessionKey: (key) => set({ hydratedSessionKey: key }),

  hydrateFromRemote: (draft, graph, sessionKey) =>
    set({
      sceneDraft: draft,
      modelBuilderGraph: graph,
      hydratedSessionKey: sessionKey,
      isDirty: false,
      syncStatus: "idle",
      syncError: null,
      validationErrors: [],
    }),

  resetAuthoring: () => set(INITIAL_STATE),
}));

/* ── Narrow selectors ── */
export const selectSceneDraft = (s: AuthoringStoreState) => s.sceneDraft;
export const selectModelBuilderGraph = (s: AuthoringStoreState) => s.modelBuilderGraph;
export const selectSyncStatus = (s: AuthoringStoreState) => s.syncStatus;
export const selectIsDirty = (s: AuthoringStoreState) => s.isDirty;
export const selectSelectedObjectId = (s: AuthoringStoreState) => s.selectedObjectId;
export const selectSelectedEntityId = (s: AuthoringStoreState) => s.selectedEntityId;
export const selectFocusedEntityId = (s: AuthoringStoreState) => s.focusedEntityId;
export const selectMeshEntityViewState = (s: AuthoringStoreState) => s.meshEntityViewState;
export const selectValidationErrors = (s: AuthoringStoreState) => s.validationErrors;
