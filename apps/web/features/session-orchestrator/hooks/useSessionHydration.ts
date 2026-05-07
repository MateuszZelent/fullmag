import { useEffect, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { WorkspaceSelectionResource } from "@/src/api/types";
import type {
  MeshEntityViewStateMap,
  ModelBuilderGraphV2,
  SceneDocument,
  ScriptBuilderState,
  VisualizationPresetRef,
} from "@/lib/session/types";
import type { MeshOptionsState } from "@/lib/mesh/options";
import type { SolverSettingsState } from "@/components/panels/SolverSettingsPanel";
import type { SolverPlanSummary } from "@/components/runs/control-room/types";
import type { ObjectViewMode } from "@/components/runs/control-room/shared";
import {
  buildModelBuilderGraphV2,
  serializeModelBuilderGraphV2,
} from "@/lib/session/modelBuilderGraph";
import {
  buildSceneDocumentFromScriptBuilder,
  buildScriptBuilderFromSceneDocument,
} from "@/lib/session/sceneDocument";
import {
  buildScriptBuilderSignature,
  meshOptionsFromBuilder,
  solverSettingsFromBuilder,
} from "@/components/runs/control-room/helpers";
import { buildMeshConfigurationSignature } from "@/components/runs/control-room/meshWorkspace";
import {
  DEFAULT_AIR_MESH_OPACITY,
  normalizePersistedMeshEntityViewState,
  normalizePersistedObjectViewMode,
  normalizeVisualizationPresetRef,
  sameMeshEntityViewStateMap,
} from "@/components/runs/control-room/controlRoomUtils";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { useVisualizationStore } from "@/features/visualization/store/useVisualizationStore";

interface BuilderAutoSyncHandle {
  isHydrated: (key: string) => boolean;
  markHydrated: (key: string) => void;
  gateAutoSync: (ms: number) => void;
  resetAutoSync: () => void;
  bumpGateVersion: () => void;
  recordPushSignature: (signature: string | null) => void;
}

interface UseSessionHydrationParams {
  builderAutoSync: BuilderAutoSyncHandle;
  meshOptions: MeshOptionsState;
  pendingMeshConfigSignatureRef: MutableRefObject<string | null>;
  remoteModelBuilderGraph: ModelBuilderGraphV2 | null;
  remoteSceneDocument: SceneDocument | null;
  scriptBuilder: ScriptBuilderState | null | undefined;
  solverPlan: SolverPlanSummary | null;
  solverSettings: SolverSettingsState;
  workspaceHydrationKey: string | null;
  workspaceSelection: WorkspaceSelectionResource | null;

  setActiveVisualizationPresetRef: Dispatch<SetStateAction<VisualizationPresetRef | null>>;
  setFocusedEntityId: Dispatch<SetStateAction<string | null>>;
  setLastBuiltMeshConfigSignature: Dispatch<SetStateAction<string | null>>;
  setMeshEntityViewState: Dispatch<SetStateAction<MeshEntityViewStateMap>>;
  setMeshOptionsState: Dispatch<SetStateAction<MeshOptionsState>>;
  setModelBuilderGraph: Dispatch<SetStateAction<ModelBuilderGraphV2 | null>>;
  setObjectViewMode: Dispatch<SetStateAction<ObjectViewMode>>;
  setRunUntilInput: Dispatch<SetStateAction<string>>;
  setSceneDocumentDraft: Dispatch<SetStateAction<SceneDocument | null>>;
  setSelectedEntityId: Dispatch<SetStateAction<string | null>>;
  setSelectedObjectId: Dispatch<SetStateAction<string | null>>;
  setSolverSettingsState: Dispatch<SetStateAction<SolverSettingsState>>;
}

const AIRBOX_DISABLED_BY_DEFAULT =
  FRONTEND_DIAGNOSTIC_FLAGS.femViewport.airboxDisabledByDefault;

export function useSessionHydration({
  builderAutoSync,
  meshOptions,
  pendingMeshConfigSignatureRef,
  remoteModelBuilderGraph,
  remoteSceneDocument,
  scriptBuilder,
  solverPlan,
  solverSettings,
  workspaceHydrationKey,
  workspaceSelection,
  setActiveVisualizationPresetRef,
  setFocusedEntityId,
  setLastBuiltMeshConfigSignature,
  setMeshEntityViewState,
  setMeshOptionsState,
  setModelBuilderGraph,
  setObjectViewMode,
  setRunUntilInput,
  setSceneDocumentDraft,
  setSelectedEntityId,
  setSelectedObjectId,
  setSolverSettingsState,
}: UseSessionHydrationParams) {
  const [solverSettingsHydrated, setSolverSettingsHydrated] = useState(false);
  const {
    bumpGateVersion,
    gateAutoSync,
    isHydrated,
    markHydrated,
    recordPushSignature,
    resetAutoSync,
  } = builderAutoSync;

  useEffect(() => {
    resetAutoSync();
    pendingMeshConfigSignatureRef.current = null;
    setLastBuiltMeshConfigSignature(null);
    setSolverSettingsHydrated(false);
    setModelBuilderGraph(null);
    setSceneDocumentDraft(null);
  }, [
    pendingMeshConfigSignatureRef,
    resetAutoSync,
    setLastBuiltMeshConfigSignature,
    setModelBuilderGraph,
    setSceneDocumentDraft,
    workspaceHydrationKey,
  ]);

  useEffect(() => {
    if (solverSettingsHydrated || !solverPlan || scriptBuilder || remoteModelBuilderGraph) {
      return;
    }
    setSolverSettingsState((prev) => ({
      ...prev,
      integrator: solverPlan.integrator ?? prev.integrator,
      fixedTimestep:
        solverPlan.fixedTimestep != null ? String(solverPlan.fixedTimestep) : prev.fixedTimestep,
      relaxAlgorithm: solverPlan.relaxation?.algorithm ?? prev.relaxAlgorithm,
      torqueTolerance:
        solverPlan.relaxation?.torqueTolerance != null
          ? String(solverPlan.relaxation.torqueTolerance)
          : prev.torqueTolerance,
      energyTolerance:
        solverPlan.relaxation?.energyTolerance != null
          ? String(solverPlan.relaxation.energyTolerance)
          : prev.energyTolerance,
      maxRelaxSteps:
        solverPlan.relaxation?.maxSteps != null
          ? String(solverPlan.relaxation.maxSteps)
          : prev.maxRelaxSteps,
    }));
    setSolverSettingsHydrated(true);
  }, [
    remoteModelBuilderGraph,
    scriptBuilder,
    setSolverSettingsState,
    solverPlan,
    solverSettingsHydrated,
  ]);

  useEffect(() => {
    const incomingGraph =
      remoteModelBuilderGraph ??
      (scriptBuilder
        ? buildModelBuilderGraphV2(scriptBuilder)
        : remoteSceneDocument
          ? buildModelBuilderGraphV2(buildScriptBuilderFromSceneDocument(remoteSceneDocument))
          : null);
    if (!workspaceHydrationKey || !incomingGraph) {
      return;
    }
    if (isHydrated(workspaceHydrationKey)) {
      return;
    }
    setSolverSettingsState((prev) => ({
      ...prev,
      ...solverSettingsFromBuilder(incomingGraph.study.solver),
    }));
    setMeshOptionsState((prev) => ({
      ...prev,
      ...meshOptionsFromBuilder(incomingGraph.study.mesh_defaults),
    }));
    setModelBuilderGraph(incomingGraph);
    const hydratedScene =
      remoteSceneDocument ??
      buildSceneDocumentFromScriptBuilder({
        revision: incomingGraph.revision,
        initial_state: incomingGraph.study.initial_state,
        ...serializeModelBuilderGraphV2(incomingGraph),
      });
    hydratedScene.study.requested_backend =
      remoteSceneDocument?.study.requested_backend ?? incomingGraph.study.requested_backend;
    hydratedScene.study.requested_device =
      remoteSceneDocument?.study.requested_device ?? incomingGraph.study.requested_device;
    hydratedScene.study.requested_precision =
      remoteSceneDocument?.study.requested_precision ?? incomingGraph.study.requested_precision;
    hydratedScene.study.requested_mode =
      remoteSceneDocument?.study.requested_mode ?? incomingGraph.study.requested_mode;
    setSceneDocumentDraft(hydratedScene);
    setLastBuiltMeshConfigSignature(buildMeshConfigurationSignature(hydratedScene));
    pendingMeshConfigSignatureRef.current = null;
    setSelectedObjectId(
      workspaceSelection?.selected_object_id ?? hydratedScene.editor.selected_object_id,
    );
    setObjectViewMode(normalizePersistedObjectViewMode(hydratedScene.editor.object_view_mode));
    useVisualizationStore.getState().patch({
      femVectorDomainFilter: hydratedScene.editor.vector_domain_filter ?? "auto",
      femFerromagnetVisibilityMode:
        hydratedScene.editor.ferromagnet_visibility_mode ?? "hide",
      airMeshVisible: AIRBOX_DISABLED_BY_DEFAULT
        ? false
        : (hydratedScene.editor.air_mesh_visible ?? false),
      airMeshOpacity:
        typeof hydratedScene.editor.air_mesh_opacity === "number" &&
        Number.isFinite(hydratedScene.editor.air_mesh_opacity)
          ? hydratedScene.editor.air_mesh_opacity
          : DEFAULT_AIR_MESH_OPACITY,
    });
    setMeshEntityViewState((previous) => {
      const next = normalizePersistedMeshEntityViewState(
        hydratedScene.editor.mesh_entity_view_state,
      );
      return sameMeshEntityViewStateMap(previous, next) ? previous : next;
    });
    setSelectedEntityId(
      workspaceSelection?.selected_entity_id ?? hydratedScene.editor.selected_entity_id,
    );
    setFocusedEntityId(hydratedScene.editor.focused_entity_id);
    setActiveVisualizationPresetRef(
      normalizeVisualizationPresetRef(hydratedScene.editor.active_visualization_preset_ref),
    );
    const firstRunStage = incomingGraph.study.stages.find(
      (stage) => stage.kind === "run" && stage.until_seconds.trim().length > 0,
    );
    if (firstRunStage) {
      setRunUntilInput(firstRunStage.until_seconds);
    }
    markHydrated(workspaceHydrationKey);
    gateAutoSync(2500);
    bumpGateVersion();
    recordPushSignature(buildScriptBuilderSignature(incomingGraph, {
      solverSettings,
      meshOptions,
      universe: incomingGraph.universe.value,
      demagRealization: incomingGraph.study.demag_realization,
      stages: incomingGraph.study.stages,
      geometries: incomingGraph.objects.items.map((objectNode) => objectNode.geometry),
      currentModules: incomingGraph.current_modules.modules,
      excitationAnalysis: incomingGraph.current_modules.excitation_analysis,
    }));
    setSolverSettingsHydrated(true);
  }, [
    bumpGateVersion,
    gateAutoSync,
    isHydrated,
    markHydrated,
    meshOptions,
    pendingMeshConfigSignatureRef,
    recordPushSignature,
    remoteModelBuilderGraph,
    remoteSceneDocument,
    scriptBuilder,
    setActiveVisualizationPresetRef,
    setFocusedEntityId,
    setLastBuiltMeshConfigSignature,
    setMeshEntityViewState,
    setMeshOptionsState,
    setModelBuilderGraph,
    setObjectViewMode,
    setRunUntilInput,
    setSceneDocumentDraft,
    setSelectedEntityId,
    setSelectedObjectId,
    setSolverSettingsState,
    solverSettings,
    workspaceHydrationKey,
    workspaceSelection,
  ]);
}
