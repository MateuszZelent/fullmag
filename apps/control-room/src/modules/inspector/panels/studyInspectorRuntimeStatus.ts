"use client";

import type { LiveStatusResource } from "@/kernel/api/apiTypes";

type StudyInspectorRuntimeStatus = {
  capabilities: Pick<
    LiveStatusResource["capabilities"],
    "active_lane" | "algorithms_available" | "binary_fields" | "explicit_topology"
  >;
  domain: Pick<LiveStatusResource["domain"], "discretization">;
  resources: Pick<
    LiveStatusResource["resources"],
    | "mesh_build_revision"
    | "mesh_revision"
    | "commands_revision"
    | "domain_generation_id"
    | "region_coefficients_revision"
    | "region_initial_state_revision"
    | "region_membership_revision"
    | "region_topology_revision"
    | "scalars_revision"
    | "scene_revision"
    | "stages_revision"
  >;
  session: Pick<LiveStatusResource["session"], "session_epoch" | "session_id">;
  run: LiveStatusResource["run"];
};

export function selectStudyInspectorRuntimeStatus(status: {
  data: LiveStatusResource | null;
}): StudyInspectorRuntimeStatus | null {
  if (!status.data) return null;
  return {
    capabilities: {
      active_lane: status.data.capabilities.active_lane,
      algorithms_available: status.data.capabilities.algorithms_available,
      binary_fields: status.data.capabilities.binary_fields,
      explicit_topology: status.data.capabilities.explicit_topology,
    },
    domain: {
      discretization: status.data.domain.discretization,
    },
    resources: {
      mesh_build_revision: status.data.resources.mesh_build_revision,
      mesh_revision: status.data.resources.mesh_revision,
      commands_revision: status.data.resources.commands_revision,
      domain_generation_id: status.data.resources.domain_generation_id,
      region_coefficients_revision: status.data.resources.region_coefficients_revision,
      region_initial_state_revision: status.data.resources.region_initial_state_revision,
      region_membership_revision: status.data.resources.region_membership_revision,
      region_topology_revision: status.data.resources.region_topology_revision,
      scalars_revision: status.data.resources.scalars_revision,
      scene_revision: status.data.resources.scene_revision,
      stages_revision: status.data.resources.stages_revision,
    },
    session: {
      session_epoch: status.data.session.session_epoch,
      session_id: status.data.session.session_id,
    },
    run: status.data.run,
  };
}

function studyInspectorRunEquals(
  previous: LiveStatusResource["run"],
  next: LiveStatusResource["run"],
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;
  return (
    previous.run_id === next.run_id &&
    previous.solver_steps === next.solver_steps &&
    previous.solver_time === next.solver_time &&
    previous.stage_count === next.stage_count &&
    previous.stage_index === next.stage_index &&
    previous.stage_label === next.stage_label &&
    previous.started_at === next.started_at
  );
}

export function studyInspectorRuntimeStatusEquals(
  previous: StudyInspectorRuntimeStatus | null,
  next: StudyInspectorRuntimeStatus | null,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;
  const previousAlgorithms = previous.capabilities.algorithms_available ?? [];
  const nextAlgorithms = next.capabilities.algorithms_available ?? [];
  if (
    previousAlgorithms.length !== nextAlgorithms.length ||
    previousAlgorithms.some((algorithm, index) => algorithm !== nextAlgorithms[index])
  ) {
    return false;
  }
  if (
    previous.session.session_id !== next.session.session_id ||
    previous.session.session_epoch !== next.session.session_epoch
  ) {
    return false;
  }
  return (
    previous.capabilities.binary_fields === next.capabilities.binary_fields &&
    previous.capabilities.active_lane === next.capabilities.active_lane &&
    previous.capabilities.explicit_topology ===
      next.capabilities.explicit_topology &&
    previous.domain.discretization === next.domain.discretization &&
    previous.resources.mesh_build_revision ===
      next.resources.mesh_build_revision &&
    previous.resources.mesh_revision === next.resources.mesh_revision &&
    previous.resources.commands_revision === next.resources.commands_revision &&
    previous.resources.domain_generation_id === next.resources.domain_generation_id &&
    previous.resources.region_coefficients_revision === next.resources.region_coefficients_revision &&
    previous.resources.region_initial_state_revision === next.resources.region_initial_state_revision &&
    previous.resources.region_membership_revision === next.resources.region_membership_revision &&
    previous.resources.region_topology_revision === next.resources.region_topology_revision &&
    previous.resources.scalars_revision === next.resources.scalars_revision &&
    previous.resources.scene_revision === next.resources.scene_revision &&
    previous.resources.stages_revision === next.resources.stages_revision &&
    studyInspectorRunEquals(previous.run, next.run)
  );
}
