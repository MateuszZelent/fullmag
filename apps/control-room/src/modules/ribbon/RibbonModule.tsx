"use client";

import { useMemo, useState, useSyncExternalStore } from "react";

import type { LiveStatusResource } from "@/kernel/api/apiTypes";
import {
  MESHING_BUILDS_CURRENT_PATH,
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MESHING_SUMMARY_PATH,
  MODEL_GEOMETRY_CAPABILITIES_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  PERSISTENCE_CHECKPOINTS_PATH,
  SIMULATION_COMMANDS_PATH,
  SIMULATION_SOLVER_STATUS_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
  VISUALIZATION_STATE_PATH,
} from "@/kernel/api/apiPaths";
import type { ModuleProps } from "@/kernel/types";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useLayoutActions, useLayoutSelector } from "@/kernel/layout/useLayout";
import { WorkspaceRenderProfiler } from "@/kernel/performance/reactRenderProfiler";
import {
  useGeometryCapabilitiesResource,
  useGeometryValidationResource,
  useMeshBuildCurrent,
  useMeshBuildLatestSuccessful,
  useMeshSemanticsResource,
  useMeshSharedDomainManifestResource,
  useMeshSummaryResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { visualizationSceneObjectIds } from "@/kernel/selection/visualizationTargetResolver";
import {
  shouldLoadRuntimeMeshBuild,
  shouldLoadRuntimeMeshManifest,
  shouldLoadRuntimeMeshSummary,
  shouldLoadRuntimeCommandQueue,
  shouldLoadRuntimeStageExecution,
  useCommandQueueResource,
  useCommandDetailResource,
  useCheckpointCatalogResource,
  useSolverStatusResource,
  useStageExecutionResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  SESSION_STATUS_RESOURCE_KEY,
  useSessionStatusSelector,
} from "@/kernel/resources/useSessionStatus";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import { EMPTY_SELECTION } from "@/kernel/selection/selectionTypes";
import {
  EMPTY_OBJECT_VISUALIZATION_SNAPSHOT,
  useObjectVisualizationController,
  useObjectVisualizationSelector,
} from "@/kernel/visualization/useObjectVisualization";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import { CommandDetailDialog } from "@/shared/runtime/CommandDetailDialog";
import { Button } from "@/shared/ui/Button";
import {
  isMeshBuildConfirmCommandId,
  requestMeshBuildConfirmation,
} from "@/kernel/authoring/meshBuildConfirmation";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";

import {
  buildRibbonTabContent,
  resolveRibbonVisualizationTarget,
} from "./ribbonContributions";
import {
  RIBBON_VISUALIZATION_APPLY_GLOBAL_QUANTITY_COMMAND,
  type ApplyGlobalQuantityInput,
} from "./ribbonCommands";
import { ribbonTabNeedsRuntimeResources } from "./ribbonResourcePolicy";
import { RibbonGroupsRow } from "./RibbonGroupsRow";
import { RibbonTabStrip } from "./RibbonTabStrip";
import { RIBBON_TABS } from "./ribbonTypes";

type RibbonRuntimeStatus = {
  capabilities: Pick<
    LiveStatusResource["capabilities"],
    "binary_fields" | "explicit_topology"
  >;
  domain: Pick<LiveStatusResource["domain"], "discretization">;
  resources: Pick<
    LiveStatusResource["resources"],
    | "field_revision"
    | "fields_revision"
    | "command_completion_revision"
    | "commands_revision"
    | "mesh_build_revision"
    | "mesh_revision"
    | "scene_revision"
      | "stages_revision"
  >;
  run: Pick<NonNullable<LiveStatusResource["run"]>, "run_id"> | null;
  session: Pick<LiveStatusResource["session"], "session_id">;
};

function selectRibbonRuntimeStatus(status: {
  data: LiveStatusResource | null;
}): RibbonRuntimeStatus | null {
  if (!status.data) return null;
  return {
    capabilities: {
      binary_fields: status.data.capabilities.binary_fields,
      explicit_topology: status.data.capabilities.explicit_topology,
    },
    domain: {
      discretization: status.data.domain.discretization,
    },
    resources: {
      field_revision: status.data.resources.field_revision,
      fields_revision: status.data.resources.fields_revision,
      command_completion_revision:
        status.data.resources.command_completion_revision,
      commands_revision: status.data.resources.commands_revision,
      mesh_build_revision: status.data.resources.mesh_build_revision,
      mesh_revision: status.data.resources.mesh_revision,
      scene_revision: status.data.resources.scene_revision,
      stages_revision: status.data.resources.stages_revision,
    },
    run: status.data.run ? { run_id: status.data.run.run_id } : null,
    session: {
      session_id: status.data.session.session_id,
    },
  };
}

function ribbonRuntimeStatusEquals(
  previous: RibbonRuntimeStatus | null,
  next: RibbonRuntimeStatus | null,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;
  return (
    previous.capabilities.binary_fields === next.capabilities.binary_fields &&
    previous.capabilities.explicit_topology ===
      next.capabilities.explicit_topology &&
    previous.domain.discretization === next.domain.discretization &&
    previous.resources.field_revision === next.resources.field_revision &&
    previous.resources.fields_revision === next.resources.fields_revision &&
    previous.resources.command_completion_revision ===
      next.resources.command_completion_revision &&
    previous.resources.commands_revision === next.resources.commands_revision &&
    previous.resources.mesh_build_revision ===
      next.resources.mesh_build_revision &&
    previous.resources.mesh_revision === next.resources.mesh_revision &&
    previous.resources.scene_revision === next.resources.scene_revision &&
    previous.resources.stages_revision === next.resources.stages_revision &&
    previous.run?.run_id === next.run?.run_id &&
    previous.session.session_id === next.session.session_id
  );
}

export default function RibbonModule({ kernel }: ModuleProps) {
  const [selectedCommandId, setSelectedCommandId] = useState<string | null>(null);
  const [pendingGlobalQuantity, setPendingGlobalQuantity] =
    useState<ApplyGlobalQuantityInput | null>(null);
  const activeTab = useLayoutSelector((layout) => layout.activeModuleTab);
  const { setActiveTab } = useLayoutActions();
  const selection = useSelectionSelector((currentSelection) =>
    activeTab === "view" ? currentSelection : EMPTY_SELECTION,
  );
  const visualization = useObjectVisualizationController();
  const visualizationSnapshot = useObjectVisualizationSelector((snapshot) =>
    activeTab === "view" ? snapshot : EMPTY_OBJECT_VISUALIZATION_SNAPSHOT,
  );
  const needsGeometryResources =
    activeTab === "geometry" || activeTab === "mesh";
  const needsRuntimeResources = ribbonTabNeedsRuntimeResources(activeTab);
  const needsMeshResources =
    activeTab === "mesh" ||
    needsRuntimeResources ||
    (activeTab === "view" && selection.ref?.type === "mesh-part");
  const needsVisualizationResources = activeTab === "view";
  const visualizationState = useVisualizationStateResource({
    enabled: needsVisualizationResources,
  });
  const geometryCapabilities = useGeometryCapabilitiesResource({
    enabled: needsGeometryResources || needsRuntimeResources,
  });
  const geometryValidation = useGeometryValidationResource({
    enabled: needsGeometryResources || needsRuntimeResources,
  });
  const needsSessionStatusResources = needsMeshResources || needsRuntimeResources;
  const sessionStatusData = useSessionStatusSelector(
    selectRibbonRuntimeStatus,
    {
      enabled: needsSessionStatusResources,
      isEqual: ribbonRuntimeStatusEquals,
    },
  );
  const meshBuildCurrent = useMeshBuildCurrent({
    enabled: shouldLoadRuntimeMeshBuild(needsMeshResources, sessionStatusData),
  });
  const meshBuildLatest = useMeshBuildLatestSuccessful({
    enabled: shouldLoadRuntimeMeshBuild(needsMeshResources, sessionStatusData),
  });
  const meshManifest = useMeshSharedDomainManifestResource({
    enabled: shouldLoadRuntimeMeshManifest(
      needsMeshResources,
      sessionStatusData,
    ),
  });
  const meshSummary = useMeshSummaryResource({
    enabled: shouldLoadRuntimeMeshSummary(
      needsMeshResources,
      sessionStatusData,
    ),
  });
  const meshSemantics = useMeshSemanticsResource({
    enabled: needsMeshResources,
  });
  const scene = useSceneResource({
    enabled: activeTab === "view" && selection.ref?.type === "mesh-part",
  });
  const sceneObjectIds = useMemo(
    () => visualizationSceneObjectIds(scene.data),
    [scene.data],
  );
  const selectedMeshPart = useMemo(
    () =>
      selection.ref?.type === "mesh-part"
        ? meshManifest.data?.mesh_parts?.find(
            (part) => part.id === selection.ref?.nodeId,
          ) ?? null
        : null,
    [meshManifest.data?.mesh_parts, selection.ref],
  );
  const commandQueue = useCommandQueueResource({
    enabled: shouldLoadRuntimeCommandQueue(
      needsRuntimeResources,
      sessionStatusData,
    ),
  });
  const solverStatus = useSolverStatusResource({
    enabled: needsRuntimeResources,
  });
  const stageExecution = useStageExecutionResource({
    enabled: shouldLoadRuntimeStageExecution(
      needsRuntimeResources,
      sessionStatusData,
    ),
  });
  const checkpointCatalog = useCheckpointCatalogResource({
    enabled: needsRuntimeResources,
  });
  const commandDetail = useCommandDetailResource(selectedCommandId);
  const commandVersion = useSyncExternalStore(
    (listener) => kernel.commands.subscribe(listener),
    () => kernel.commands.getVersion(),
    () => kernel.commands.getVersion(),
  );

  const visualizationTarget = useMemo(
    () =>
      resolveRibbonVisualizationTarget({
        sceneObjectIds,
        selectedMeshPart,
        selection,
        visualizationState: visualizationState.data,
      }),
    [sceneObjectIds, selectedMeshPart, selection, visualizationState.data],
  );

  const commandContext = useMemo(
    () =>
      createCommandContext("ribbon", kernel, {
        resourceData: {
          [MESHING_BUILDS_CURRENT_PATH]: meshBuildCurrent.data,
          [MESHING_BUILDS_LATEST_SUCCESSFUL_PATH]: meshBuildLatest.data,
          [MESHING_SHARED_DOMAIN_MANIFEST_PATH]: meshManifest.data,
          [MESHING_SUMMARY_PATH]: meshSummary.data,
          [MODEL_GEOMETRY_CAPABILITIES_PATH]: geometryCapabilities.data,
          [MODEL_GEOMETRY_VALIDATION_PATH]: geometryValidation.data,
          [PERSISTENCE_CHECKPOINTS_PATH]: needsRuntimeResources
            ? checkpointCatalog.data
            : null,
          [SIMULATION_COMMANDS_PATH]: needsRuntimeResources
            ? commandQueue.data
            : null,
          [SIMULATION_SOLVER_STATUS_PATH]: needsRuntimeResources
            ? solverStatus.data
            : null,
          [SIMULATION_STAGES_EXECUTION_PATH]: needsRuntimeResources
            ? stageExecution.data
            : null,
          [SESSION_STATUS_RESOURCE_KEY]: needsRuntimeResources
            ? sessionStatusData
            : null,
          [VISUALIZATION_STATE_PATH]: visualizationState.data,
        },
        sourceDetail: activeTab,
        visualizationTarget,
      }),
    [
      activeTab,
      geometryCapabilities.data,
      geometryValidation.data,
      kernel,
      checkpointCatalog.data,
      commandQueue.data,
      meshBuildCurrent.data,
      needsRuntimeResources,
      meshBuildLatest.data,
      meshManifest.data,
      meshSummary.data,
      sessionStatusData,
      solverStatus.data,
      stageExecution.data,
      visualizationState.data,
      visualizationTarget,
    ],
  );

  const tabContent = useMemo(
    () => {
      void commandVersion;
      return buildRibbonTabContent(activeTab, {
        api: kernel.api,
        commandContext,
        commands: kernel.commands,
        meshBuildCurrent: meshBuildCurrent.data,
        meshBuildLatest: meshBuildLatest.data,
        meshSemantics: meshSemantics.data,
        meshSummary: meshSummary.data,
        resources: kernel.resources,
        selection,
        sceneObjectIds,
        selectedMeshPart,
        sessionStatus: sessionStatusData,
        visualization,
        visualizationSnapshot,
        visualizationState: visualizationState.data,
      });
    },
    [
      activeTab,
      commandContext,
      commandVersion,
      kernel.api,
      kernel.commands,
      kernel.resources,
      meshBuildCurrent.data,
      meshBuildLatest.data,
      meshSemantics.data,
      meshSummary.data,
      selection,
      sceneObjectIds,
      selectedMeshPart,
      sessionStatusData,
      visualization,
      visualizationSnapshot,
      visualizationState.data,
    ],
  );
  const groups = tabContent?.groups ?? [];

  function handleAction(actionId: string, input?: unknown): void {
    if (
      actionId === RIBBON_VISUALIZATION_APPLY_GLOBAL_QUANTITY_COMMAND &&
      isGlobalQuantityConfirmationInput(input)
    ) {
      setPendingGlobalQuantity(input);
      return;
    }
    if (isMeshBuildConfirmCommandId(actionId)) {
      requestMeshBuildConfirmation(kernel.bus, {
        commandId: actionId,
        input,
        source: "ribbon",
        sourceDetail: "ribbon-action",
      });
      return;
    }
    void kernel.commands.execute(actionId, commandContext, input);
  }

  function confirmGlobalQuantity(): void {
    if (!pendingGlobalQuantity) return;
    const input: ApplyGlobalQuantityInput = {
      ...pendingGlobalQuantity,
      requiresConfirmation: false,
    };
    setPendingGlobalQuantity(null);
    void kernel.commands.execute(
      RIBBON_VISUALIZATION_APPLY_GLOBAL_QUANTITY_COMMAND,
      commandContext,
      input,
    );
  }

  return (
    <WorkspaceRenderProfiler id="RibbonModule">
      <div className="fm-ribbon">
      <RibbonTabStrip
        activeTabId={activeTab}
        tabs={RIBBON_TABS}
        onTabClick={setActiveTab}
      />
      <RibbonGroupsRow
        groups={groups}
        onAction={handleAction}
        onCommandDetail={setSelectedCommandId}
      />
      <CommandDetailDialog
        commandId={selectedCommandId}
        detail={commandDetail}
        onOpenChange={(open) => {
          if (!open) setSelectedCommandId(null);
        }}
      />
      <Dialog
        open={pendingGlobalQuantity !== null}
        onOpenChange={(open) => {
          if (!open) setPendingGlobalQuantity(null);
        }}
      >
        <DialogContent aria-describedby="fm-global-quantity-description">
          <DialogHeader>
            <DialogTitle>Apply Global Quantity</DialogTitle>
            <DialogDescription id="fm-global-quantity-description">
              This will replace per-target quantity choices with{" "}
              {pendingGlobalQuantity?.activeQuantityId ?? "the selected quantity"}.
            </DialogDescription>
          </DialogHeader>
          <p className="fm-dialog__description">
            {pendingGlobalQuantity?.targetQuantityOverrideCount ?? 0} target
            quantities are currently different from the global quantity.
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button type="button" variant="primary" onClick={confirmGlobalQuantity}>
              Apply Globally
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </WorkspaceRenderProfiler>
  );
}

export const __ribbonModuleTestUtils = {
  ribbonRuntimeStatusEquals,
  selectRibbonRuntimeStatus,
};

function isGlobalQuantityConfirmationInput(
  input: unknown,
): input is ApplyGlobalQuantityInput {
  return (
    Boolean(input) &&
    typeof input === "object" &&
    (input as ApplyGlobalQuantityInput).requiresConfirmation === true &&
    typeof (input as ApplyGlobalQuantityInput).activeQuantityId === "string"
  );
}
