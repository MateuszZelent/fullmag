/**
 * Layer C: Study Authoring – Scene Draft Types
 *
 * SceneDraft is the SINGLE editable representation of the scene.
 * It is the authoring store's canonical model.
 *
 * Only two canonical representations exist:
 * 1. SceneDraft — local authoring model (this file)
 * 2. RemoteSessionScene — runtime snapshot from backend (session-runtime layer)
 *
 * Adapters between them are explicit and live in ../adapters/.
 */

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

/** Sync state machine: explicit states for draft → backend flow */
export type DraftSyncStatus =
  | "idle"
  | "dirty"
  | "validating"
  | "committing"
  | "saved"
  | "backend_rejected"
  | "network_retrying"
  | "conflict";

/** Validation error returned before commit */
export interface DraftValidationError {
  path: string;
  message: string;
  severity: "error" | "warning";
}

/**
 * Complete authoring state.
 * This replaces the scattered useState calls in ControlRoomContext.
 */
export interface AuthoringState {
  /** The local scene document draft — THE source of truth for authoring */
  sceneDraft: SceneDocument | null;

  /** Model builder graph derived from sceneDraft */
  modelBuilderGraph: ModelBuilderGraphV2 | null;

  /** Solver configuration */
  solverSettings: SolverSettingsState;
  meshOptions: MeshOptionsState;

  /** Study pipeline state */
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

  /** Selection / focus (authoring domain) */
  selectedSidebarNodeId: string | null;
  selectedObjectId: string | null;
  selectedEntityId: string | null;
  focusedEntityId: string | null;

  /** Mesh entity view state per part */
  meshEntityViewState: MeshEntityViewStateMap;

  /** Visualization presets */
  visualizationProjectPresets: VisualizationPreset[];
  visualizationLocalPresets: VisualizationPreset[];
  activeVisualizationPresetRef: VisualizationPresetRef | null;

  /** Sync status */
  syncStatus: DraftSyncStatus;
  syncError: string | null;
  lastSyncSignature: string | null;
  pendingCommitCount: number;

  /** Dirty tracking */
  isDirty: boolean;
  validationErrors: DraftValidationError[];

  /** Hydration tracking */
  hydratedSessionKey: string | null;
}
