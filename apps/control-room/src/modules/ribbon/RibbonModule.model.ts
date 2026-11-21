import { type Selection } from "@/kernel/selection/selectionTypes";
import { ANALYSIS_FEATURE_MANIFESTS } from "@/kernel/analysis-modules/analysisModuleManifests";
import { analysisModuleIdForNodeKind } from "@/kernel/analysis-modules/analysisSurfaceRouting";
import type { LiveStatusResource } from "@/kernel/api/apiTypes";

type RibbonRuntimeStatus = {
  capabilities: Pick<
    LiveStatusResource["capabilities"],
    "active_lane" | "binary_fields" | "explicit_topology"
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

export function selectRibbonRuntimeStatus(status: {
  data: LiveStatusResource | null;
}): RibbonRuntimeStatus | null {
  if (!status.data) return null;
  return {
    capabilities: {
      active_lane: status.data.capabilities.active_lane,
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

export function ribbonRuntimeStatusEquals(
  previous: RibbonRuntimeStatus | null,
  next: RibbonRuntimeStatus | null,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;
  return (
    previous.capabilities.binary_fields === next.capabilities.binary_fields &&
    previous.capabilities.active_lane === next.capabilities.active_lane &&
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

export const __ribbonModuleTestUtils = {
  ribbonRuntimeStatusEquals,
  selectRibbonRuntimeStatus,
  contextualAnalysisModuleIdForSelection,
  contextualRibbonTabIsActive,
  contextualTabDismissalForModuleChange,
};

export interface ContextualTabDismissalState {
  contextModuleId: string | null;
  dismissed: boolean;
}

export function contextualAnalysisModuleIdForSelection(
  selection: Pick<Selection, "kind" | "ref">,
): string | null {
  const ref = selection.ref;
  if (ref?.type === "analysis-pinned-group") {
    return ANALYSIS_FEATURE_MANIFESTS.find((manifest) => manifest.id === ref.moduleId)?.id ?? null;
  }
  return analysisModuleIdForNodeKind(selection.kind ?? "");
}

export function contextualTabDismissalForModuleChange(
  state: ContextualTabDismissalState,
  contextModuleId: string | null,
): ContextualTabDismissalState {
  return state.contextModuleId === contextModuleId
    ? state
    : { contextModuleId, dismissed: false };
}

export function contextualRibbonTabIsActive(
  state: ContextualTabDismissalState,
  contextModuleId: string | null,
  hasContextModuleTitle: boolean,
): boolean {
  return hasContextModuleTitle &&
    (state.contextModuleId !== contextModuleId || !state.dismissed);
}
