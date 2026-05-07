import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { AuthoringStudyRuntimePatchRequest } from "@/src/api/types";
import type {
  ModelBuilderGraphV2,
  SceneDocument,
  ScriptBuilderCurrentModuleEntry,
  ScriptBuilderExcitationAnalysisEntry,
  ScriptBuilderGeometryEntry,
  ScriptBuilderUniverseState,
  StudyPipelineDocumentState,
} from "../../../../lib/session/types";
import type { ScriptBuilderInitialState, ScriptBuilderStageState } from "@/lib/session/types";
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
  patchStudyRuntime: (request: AuthoringStudyRuntimePatchRequest) => Promise<unknown>;
  setModelBuilderGraph: Dispatch<SetStateAction<ModelBuilderGraphV2 | null>>;
  setSceneDocumentDraft: Dispatch<SetStateAction<SceneDocument | null>>;
  setSolverSettingsState: Dispatch<SetStateAction<SolverSettingsState>>;
  setMeshOptionsState: Dispatch<SetStateAction<MeshOptionsState>>;
}

export function useModelBuilderActions({
  modelBuilderDefaults,
  sceneDocumentDraft,
  localBuilderDraft,
  patchStudyRuntime,
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
      let nextRuntimeSelection:
        | {
            requested_backend: string;
            requested_device: string;
            requested_precision: string;
            requested_mode: string;
            requested_cpu_threads: number | null;
          }
        | null = null;

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
        nextRuntimeSelection = nextRuntime;
        return {
          ...previousScene,
          study: {
            ...previousScene.study,
            ...nextRuntime,
          },
        };
      });

      if (nextRuntimeSelection) {
        void patchStudyRuntime(nextRuntimeSelection)
          .catch((error) => {
            console.error("failed to patch authoring study runtime", error);
          });
      }
    },
    [modelBuilderDefaults, patchStudyRuntime, setModelBuilderGraph, setSceneDocumentDraft],
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
  };
}
