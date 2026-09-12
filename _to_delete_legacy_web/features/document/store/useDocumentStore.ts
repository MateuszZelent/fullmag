import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { SetStateAction } from "react";
import {
  DEFAULT_SOLVER_SETTINGS,
  type SolverSettingsState,
} from "@/components/panels/SolverSettingsPanel";
import type { SolverPlanSummary } from "@/components/runs/control-room/types";
import type {
  ModelBuilderGraphV2,
  SceneObject,
  SceneDocument,
  ScriptBuilderCurrentModuleEntry,
  ScriptBuilderExcitationAnalysisEntry,
  ScriptBuilderGeometryEntry,
  ScriptBuilderUniverseState,
  StudyPipelineDocumentState,
} from "@/lib/session/types";
import type { ScriptBuilderStageState } from "@/lib/session/types";
import {
  selectModelBuilderCurrentModules,
  selectModelBuilderExcitationAnalysis,
  selectModelBuilderGeometries,
  selectModelBuilderStages,
  selectModelBuilderStudyPipeline,
  selectModelBuilderUniverse,
  buildModelBuilderGraphV2,
  setModelBuilderCurrentModules as applyModelBuilderCurrentModules,
  setModelBuilderDemagRealization as applyModelBuilderDemagRealization,
  setModelBuilderExcitationAnalysis as applyModelBuilderExcitationAnalysis,
  setModelBuilderRequestedRuntime,
  setModelBuilderStages,
  setModelBuilderStudyPipeline,
} from "@/lib/session/modelBuilderGraph";
import { buildScriptBuilderFromSceneDocument } from "@/lib/session/sceneDocument";

export interface RequestedRuntimeSelection {
  requested_backend: string;
  requested_device: string;
  requested_precision: string;
  requested_mode: string;
  requested_cpu_threads: number | null;
}

export interface DocumentStoreState {
  solverSettings: SolverSettingsState;
  solverPlan: SolverPlanSummary | null;
  modelBuilderGraph: ModelBuilderGraphV2 | null;
  sceneDocumentDraft: SceneDocument | null;
  remoteSceneDocument: SceneDocument | null;
  sceneObjects: SceneObject[];
  meshPerGeometryPayload: Record<string, unknown>[];
  studyStages: ScriptBuilderStageState[];
  studyPipeline: StudyPipelineDocumentState | null;
  scriptBuilderDemagRealization: string | null;
  scriptBuilderUniverse: ScriptBuilderUniverseState | null;
  scriptBuilderGeometries: ScriptBuilderGeometryEntry[];
  scriptBuilderCurrentModules: ScriptBuilderCurrentModuleEntry[];
  scriptBuilderExcitationAnalysis: ScriptBuilderExcitationAnalysisEntry | null;
  requestedRuntimeSelection: RequestedRuntimeSelection;
  setSolverSettings: (settings: SetStateAction<SolverSettingsState>) => void;
  setSolverPlan: (plan: SolverPlanSummary | null) => void;
  setRequestedRuntimeSelection: (
    selection: SetStateAction<RequestedRuntimeSelection>
  ) => RequestedRuntimeSelection;
  setModelBuilderGraph: (graph: SetStateAction<ModelBuilderGraphV2 | null>) => void;
  setStudyStages: (stages: SetStateAction<ScriptBuilderStageState[]>) => void;
  setStudyPipeline: (pipeline: SetStateAction<StudyPipelineDocumentState | null>) => void;
  setScriptBuilderDemagRealization: (realization: SetStateAction<string | null>) => void;
  setScriptBuilderCurrentModules: (
    modules: SetStateAction<ScriptBuilderCurrentModuleEntry[]>
  ) => void;
  setScriptBuilderExcitationAnalysis: (
    analysis: SetStateAction<ScriptBuilderExcitationAnalysisEntry | null>
  ) => void;
  setSceneDocument: (scene: SetStateAction<SceneDocument | null>) => void;
  setSceneDocumentDraft: (scene: SetStateAction<SceneDocument | null>) => void;
  setRemoteSceneDocument: (scene: SceneDocument | null) => void;
}

function buildMeshPerGeometryPayload(sceneObjects: SceneObject[]): Record<string, unknown>[] {
  return sceneObjects.map((object) => ({
    geometry: object.name,
    mode: object.mesh_override?.mode ?? "inherit",
    hmax: object.mesh_override?.hmax ?? "",
    hmin: object.mesh_override?.hmin ?? "",
    order: object.mesh_override?.order ?? null,
    source: object.mesh_override?.source ?? null,
    algorithm_2d: object.mesh_override?.algorithm_2d ?? null,
    algorithm_3d: object.mesh_override?.algorithm_3d ?? null,
    size_factor: object.mesh_override?.size_factor ?? null,
    size_from_curvature: object.mesh_override?.size_from_curvature ?? null,
    growth_rate: object.mesh_override?.growth_rate ?? "",
    narrow_regions: object.mesh_override?.narrow_regions ?? null,
    smoothing_steps: object.mesh_override?.smoothing_steps ?? null,
    optimize: object.mesh_override?.optimize ?? null,
    optimize_iterations: object.mesh_override?.optimize_iterations ?? null,
    compute_quality: object.mesh_override?.compute_quality ?? null,
    per_element_quality: object.mesh_override?.per_element_quality ?? null,
    size_fields: object.mesh_override?.size_fields ?? [],
    operations: object.mesh_override?.operations ?? [],
    build_requested: object.mesh_override?.build_requested ?? false,
  }));
}

export const useDocumentStore = create<DocumentStoreState>()(
  subscribeWithSelector((set) => ({
  solverSettings: DEFAULT_SOLVER_SETTINGS,
  solverPlan: null,
  modelBuilderGraph: null,
  sceneDocumentDraft: null,
  remoteSceneDocument: null,
  sceneObjects: [],
  meshPerGeometryPayload: [],
  studyStages: [],
  studyPipeline: null,
  scriptBuilderDemagRealization: null,
  scriptBuilderUniverse: null,
  scriptBuilderGeometries: [],
  scriptBuilderCurrentModules: [],
  scriptBuilderExcitationAnalysis: null,
  requestedRuntimeSelection: {
    requested_backend: "auto",
    requested_device: "auto",
    requested_precision: "double",
    requested_mode: "strict",
    requested_cpu_threads: null,
  },

  setSolverSettings: (settings) =>
    set((prev) => ({
      solverSettings:
        typeof settings === "function"
          ? settings(prev.solverSettings)
          : settings,
    })),

  setSolverPlan: (plan) => set({ solverPlan: plan }),

  setRequestedRuntimeSelection: (selection) => {
    let resolvedSelection: RequestedRuntimeSelection = {
      requested_backend: "auto",
      requested_device: "auto",
      requested_precision: "double",
      requested_mode: "strict",
      requested_cpu_threads: null,
    };
    set((prev) => {
      const currentSelection = prev.requestedRuntimeSelection;
      resolvedSelection =
        typeof selection === "function"
          ? (selection as (current: RequestedRuntimeSelection) => RequestedRuntimeSelection)(
              currentSelection,
            )
          : selection;
      const nextGraph = setModelBuilderRequestedRuntime(
        prev.modelBuilderGraph,
        resolvedSelection,
      );
      const nextScene = prev.sceneDocumentDraft
        ? {
            ...prev.sceneDocumentDraft,
            study: {
              ...prev.sceneDocumentDraft.study,
              ...resolvedSelection,
            },
          }
        : prev.sceneDocumentDraft;
      return {
        requestedRuntimeSelection: resolvedSelection,
        modelBuilderGraph: nextGraph,
        sceneDocumentDraft: nextScene,
      };
    });
    return resolvedSelection;
  },

  setModelBuilderGraph: (graph) =>
    set((prev) => ({
      modelBuilderGraph:
        typeof graph === "function"
          ? graph(prev.modelBuilderGraph)
          : graph,
    })),

  setStudyStages: (stages) =>
    set((prev) => ({
      modelBuilderGraph: setModelBuilderStages(prev.modelBuilderGraph, stages),
    })),

  setStudyPipeline: (pipeline) =>
    set((prev) => ({
      modelBuilderGraph: setModelBuilderStudyPipeline(prev.modelBuilderGraph, pipeline),
    })),

  setScriptBuilderDemagRealization: (realization) =>
    set((prev) => ({
      modelBuilderGraph: applyModelBuilderDemagRealization(
        prev.modelBuilderGraph,
        realization,
      ),
    })),

  setScriptBuilderCurrentModules: (modules) =>
    set((prev) => ({
      modelBuilderGraph: applyModelBuilderCurrentModules(prev.modelBuilderGraph, modules),
    })),

  setScriptBuilderExcitationAnalysis: (analysis) =>
    set((prev) => ({
      modelBuilderGraph: applyModelBuilderExcitationAnalysis(
        prev.modelBuilderGraph,
        analysis,
      ),
    })),

  setSceneDocument: (scene) =>
    set((prev) => {
      const baseScene = prev.sceneDocumentDraft ?? prev.remoteSceneDocument;
      const nextScene =
        typeof scene === "function"
          ? (scene as (current: SceneDocument | null) => SceneDocument | null)(baseScene)
          : scene;
      if (!nextScene) {
        return {
          sceneDocumentDraft: null,
          modelBuilderGraph: null,
        };
      }
      const nextGraph = buildModelBuilderGraphV2(
        buildScriptBuilderFromSceneDocument(nextScene),
      );
      if (nextGraph) {
        nextGraph.study.requested_backend = nextScene.study.requested_backend;
        nextGraph.study.requested_device = nextScene.study.requested_device;
        nextGraph.study.requested_precision = nextScene.study.requested_precision;
        nextGraph.study.requested_mode = nextScene.study.requested_mode;
      }
      return {
        sceneDocumentDraft: nextScene,
        modelBuilderGraph: nextGraph ?? null,
      };
    }),

  setSceneDocumentDraft: (scene) =>
    set((prev) => ({
      sceneDocumentDraft:
        typeof scene === "function"
          ? scene(prev.sceneDocumentDraft)
          : scene,
    })),

  setRemoteSceneDocument: (scene) => set({ remoteSceneDocument: scene }),
})),
);

useDocumentStore.subscribe(
  (s) => [s.sceneDocumentDraft, s.remoteSceneDocument] as const,
  ([sceneDocumentDraft, remoteSceneDocument]) => {
    const sceneObjects =
      sceneDocumentDraft?.objects ?? remoteSceneDocument?.objects ?? [];
    useDocumentStore.setState({
      sceneObjects,
      meshPerGeometryPayload: buildMeshPerGeometryPayload(sceneObjects),
    });
  },
  {
    equalityFn: (previous, next) => previous[0] === next[0] && previous[1] === next[1],
    fireImmediately: true,
  },
);

useDocumentStore.subscribe(
  (s) => s.modelBuilderGraph,
  (modelBuilderGraph) => {
    useDocumentStore.setState({
      studyStages: selectModelBuilderStages(modelBuilderGraph),
      studyPipeline: selectModelBuilderStudyPipeline(modelBuilderGraph),
      scriptBuilderDemagRealization: modelBuilderGraph?.study.demag_realization ?? null,
      scriptBuilderUniverse: selectModelBuilderUniverse(modelBuilderGraph),
      scriptBuilderGeometries: selectModelBuilderGeometries(modelBuilderGraph),
      scriptBuilderCurrentModules: selectModelBuilderCurrentModules(modelBuilderGraph),
      scriptBuilderExcitationAnalysis:
        selectModelBuilderExcitationAnalysis(modelBuilderGraph),
      requestedRuntimeSelection: {
        requested_backend: modelBuilderGraph?.study.requested_backend ?? "auto",
        requested_device: modelBuilderGraph?.study.requested_device ?? "auto",
        requested_precision: modelBuilderGraph?.study.requested_precision ?? "double",
        requested_mode: modelBuilderGraph?.study.requested_mode ?? "strict",
        requested_cpu_threads: modelBuilderGraph?.study.requested_cpu_threads ?? null,
      },
    });
  },
  { fireImmediately: true },
);

export const selectSolverSettings = (s: DocumentStoreState) => s.solverSettings;
export const selectSolverPlan = (s: DocumentStoreState) => s.solverPlan;
export const selectRequestedRuntimeSelection = (s: DocumentStoreState) =>
  s.requestedRuntimeSelection;
export const selectModelBuilderGraph = (s: DocumentStoreState) => s.modelBuilderGraph;
export const selectSceneDocumentDraft = (s: DocumentStoreState) => s.sceneDocumentDraft;
export const selectRemoteSceneDocument = (s: DocumentStoreState) => s.remoteSceneDocument;
export const selectSceneObjects = (s: DocumentStoreState) => s.sceneObjects;
export const selectMeshPerGeometryPayload = (s: DocumentStoreState) =>
  s.meshPerGeometryPayload;
export const selectStudyStages = (s: DocumentStoreState): ScriptBuilderStageState[] =>
  s.studyStages;
export const selectStudyPipeline = (
  s: DocumentStoreState,
): StudyPipelineDocumentState | null =>
  s.studyPipeline;
export const selectScriptBuilderDemagRealization = (
  s: DocumentStoreState,
): string | null => s.scriptBuilderDemagRealization;
export const selectScriptBuilderUniverse = (
  s: DocumentStoreState,
): ScriptBuilderUniverseState | null => s.scriptBuilderUniverse;
export const selectScriptBuilderGeometries = (
  s: DocumentStoreState,
): ScriptBuilderGeometryEntry[] => s.scriptBuilderGeometries;
export const selectScriptBuilderCurrentModules = (
  s: DocumentStoreState,
): ScriptBuilderCurrentModuleEntry[] => s.scriptBuilderCurrentModules;
export const selectScriptBuilderExcitationAnalysis = (
  s: DocumentStoreState,
): ScriptBuilderExcitationAnalysisEntry | null =>
  s.scriptBuilderExcitationAnalysis;
