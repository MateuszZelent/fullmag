import { useCallback, useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  ModelBuilderGraphV2,
  SceneDocument,
  ScriptBuilderCurrentModuleEntry,
  ScriptBuilderExcitationAnalysisEntry,
  ScriptBuilderGeometryEntry,
  ScriptBuilderUniverseState,
  StudyPipelineDocumentState,
} from "../../../../lib/session/types";
import type { ScriptBuilderInitialState, ScriptBuilderStageState } from "../../../../lib/useSessionStream";
import type { SolverSettingsState } from "../../../panels/SolverSettingsPanel";
import type { MeshOptionsState } from "../../../panels/MeshSettingsPanel";
import {
  setModelBuilderCurrentModules as applyModelBuilderCurrentModules,
  setModelBuilderDemagRealization as applyModelBuilderDemagRealization,
  setModelBuilderExcitationAnalysis as applyModelBuilderExcitationAnalysis,
  setModelBuilderGeometries as applyModelBuilderGeometries,
  setModelBuilderMeshDefaults as applyModelBuilderMeshDefaults,
  setModelBuilderRequestedRuntime as applyModelBuilderRequestedRuntime,
  setModelBuilderSolver as applyModelBuilderSolver,
  setModelBuilderStudyPipeline as applyModelBuilderStudyPipeline,
  setModelBuilderStages as applyModelBuilderStages,
  setModelBuilderUniverse as applyModelBuilderUniverse,
  buildModelBuilderGraphV2,
  serializeModelBuilderGraphV2,
} from "../../../../lib/session/modelBuilderGraph";
import {
  buildSceneDocumentFromScriptBuilder,
  buildScriptBuilderFromSceneDocument,
} from "../../../../lib/session/sceneDocument";
import {
  solverSettingsToBuilder,
  meshOptionsToBuilder,
} from "../helpers";

export interface ModelBuilderDefaults {
  revision: number;
  solver: ReturnType<typeof solverSettingsToBuilder>;
  mesh: ReturnType<typeof meshOptionsToBuilder>;
  initialState: ScriptBuilderInitialState | null | undefined;
}

export interface UseModelBuilderActionsParams {
  modelBuilderDefaults: ModelBuilderDefaults;
  sceneDocumentDraft: SceneDocument | null;
  localBuilderDraft: SceneDocument | null;
  remoteSceneDocument: SceneDocument | null;
  setModelBuilderGraph: Dispatch<SetStateAction<ModelBuilderGraphV2 | null>>;
  setSceneDocumentDraft: Dispatch<SetStateAction<SceneDocument | null>>;
  setSolverSettingsState: Dispatch<SetStateAction<SolverSettingsState>>;
  setMeshOptionsState: Dispatch<SetStateAction<MeshOptionsState>>;
}

export function useModelBuilderActions({
  modelBuilderDefaults,
  sceneDocumentDraft,
  localBuilderDraft,
  remoteSceneDocument,
  setModelBuilderGraph,
  setSceneDocumentDraft,
  setSolverSettingsState,
  setMeshOptionsState,
}: UseModelBuilderActionsParams) {
  const setSolverSettings = useCallback<Dispatch<SetStateAction<SolverSettingsState>>>(
    (update) => {
      setSolverSettingsState((prev) => {
        const next = typeof update === "function" ? update(prev) : update;
        setModelBuilderGraph((currentGraph) =>
          applyModelBuilderSolver(
            currentGraph,
            solverSettingsToBuilder(next),
            modelBuilderDefaults,
          ),
        );
        return next;
      });
    },
    [modelBuilderDefaults, setModelBuilderGraph, setSolverSettingsState],
  );

  const setMeshOptions = useCallback<Dispatch<SetStateAction<MeshOptionsState>>>(
    (update) => {
      setMeshOptionsState((prev) => {
        const next = typeof update === "function" ? update(prev) : update;
        setModelBuilderGraph((currentGraph) =>
          applyModelBuilderMeshDefaults(
            currentGraph,
            meshOptionsToBuilder(next, currentGraph?.study.mesh_defaults),
            modelBuilderDefaults,
          ),
        );
        return next;
      });
    },
    [modelBuilderDefaults, setModelBuilderGraph, setMeshOptionsState],
  );

  const setStudyStages = useCallback<Dispatch<SetStateAction<ScriptBuilderStageState[]>>>(
    (update) => {
      setModelBuilderGraph((currentGraph) =>
        applyModelBuilderStages(currentGraph, update, modelBuilderDefaults),
      );
    },
    [modelBuilderDefaults, setModelBuilderGraph],
  );

  const setStudyPipeline = useCallback<
    Dispatch<SetStateAction<StudyPipelineDocumentState | null>>
  >(
    (update) => {
      setModelBuilderGraph((currentGraph) =>
        applyModelBuilderStudyPipeline(currentGraph, update, modelBuilderDefaults),
      );
    },
    [modelBuilderDefaults, setModelBuilderGraph],
  );

  const setRequestedRuntimeSelection = useCallback<
    Dispatch<
      SetStateAction<{
        requested_backend: string;
        requested_device: string;
        requested_precision: string;
        requested_mode: string;
        requested_cpu_threads: number | null;
      }>
    >
  >(
    (update) => {
      setModelBuilderGraph((currentGraph) =>
        applyModelBuilderRequestedRuntime(currentGraph, update, modelBuilderDefaults),
      );
      setSceneDocumentDraft((previousScene) => {
        if (!previousScene) {
          return previousScene;
        }
        const currentRuntime = {
          requested_backend: previousScene.study.requested_backend,
          requested_device: previousScene.study.requested_device,
          requested_precision: previousScene.study.requested_precision,
          requested_mode: previousScene.study.requested_mode,
          requested_cpu_threads: previousScene.study.requested_cpu_threads,
        };
        const nextRuntime =
          typeof update === "function" ? update(currentRuntime) : update;
        return {
          ...previousScene,
          study: {
            ...previousScene.study,
            ...nextRuntime,
          },
        };
      });
    },
    [modelBuilderDefaults, setModelBuilderGraph, setSceneDocumentDraft],
  );

  const setScriptBuilderDemagRealization = useCallback<
    Dispatch<SetStateAction<string | null>>
  >(
    (update) => {
      setModelBuilderGraph((currentGraph) =>
        applyModelBuilderDemagRealization(currentGraph, update, modelBuilderDefaults),
      );
    },
    [modelBuilderDefaults, setModelBuilderGraph],
  );

  const setScriptBuilderUniverse = useCallback<
    Dispatch<SetStateAction<ScriptBuilderUniverseState | null>>
  >(
    (update) => {
      setModelBuilderGraph((currentGraph) =>
        applyModelBuilderUniverse(currentGraph, update, modelBuilderDefaults),
      );
    },
    [modelBuilderDefaults, setModelBuilderGraph],
  );

  const setScriptBuilderGeometries = useCallback<
    Dispatch<SetStateAction<ScriptBuilderGeometryEntry[]>>
  >(
    (update) => {
      setModelBuilderGraph((currentGraph) =>
        applyModelBuilderGeometries(currentGraph, update, modelBuilderDefaults),
      );
    },
    [modelBuilderDefaults, setModelBuilderGraph],
  );

  const setScriptBuilderCurrentModules = useCallback<
    Dispatch<SetStateAction<ScriptBuilderCurrentModuleEntry[]>>
  >(
    (update) => {
      setModelBuilderGraph((currentGraph) =>
        applyModelBuilderCurrentModules(currentGraph, update, modelBuilderDefaults),
      );
    },
    [modelBuilderDefaults, setModelBuilderGraph],
  );

  const setScriptBuilderExcitationAnalysis = useCallback<
    Dispatch<SetStateAction<ScriptBuilderExcitationAnalysisEntry | null>>
  >(
    (update) => {
      setModelBuilderGraph((currentGraph) =>
        applyModelBuilderExcitationAnalysis(currentGraph, update, modelBuilderDefaults),
      );
    },
    [modelBuilderDefaults, setModelBuilderGraph],
  );

  const setSceneDocument = useCallback<Dispatch<SetStateAction<SceneDocument | null>>>(
    (update) => {
      const baseScene = sceneDocumentDraft ?? localBuilderDraft;
      const nextScene =
        typeof update === "function"
          ? (update as (current: SceneDocument | null) => SceneDocument | null)(baseScene)
          : update;
      setSceneDocumentDraft(nextScene);
      setModelBuilderGraph(() => {
        if (!nextScene) {
          return null;
        }
        const nextGraph = buildModelBuilderGraphV2(buildScriptBuilderFromSceneDocument(nextScene));
        if (!nextGraph) {
          return null;
        }
        nextGraph.study.requested_backend = nextScene.study.requested_backend;
        nextGraph.study.requested_device = nextScene.study.requested_device;
        nextGraph.study.requested_precision = nextScene.study.requested_precision;
        nextGraph.study.requested_mode = nextScene.study.requested_mode;
        return nextGraph;
      });
    },
    [localBuilderDraft, sceneDocumentDraft, setModelBuilderGraph, setSceneDocumentDraft],
  );

  const sceneObjects = useMemo(
    () => localBuilderDraft?.objects ?? remoteSceneDocument?.objects ?? [],
    [localBuilderDraft, remoteSceneDocument],
  );

  const meshPerGeometryPayload = useMemo(
    () =>
      sceneObjects.map((object) => ({
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
      })),
    [sceneObjects],
  );

  return {
    setSolverSettings,
    setMeshOptions,
    setStudyStages,
    setStudyPipeline,
    setRequestedRuntimeSelection,
    setScriptBuilderDemagRealization,
    setScriptBuilderUniverse,
    setScriptBuilderGeometries,
    setScriptBuilderCurrentModules,
    setScriptBuilderExcitationAnalysis,
    setSceneDocument,
    sceneObjects,
    meshPerGeometryPayload,
  };
}
