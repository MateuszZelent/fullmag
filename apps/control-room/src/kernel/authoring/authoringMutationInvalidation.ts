import {
  DATA_FIELDS_PATH,
  DATA_OBSERVATION_FRAMES_PATH,
  DATA_SCALARS_PATH,
  MESHING_BUILDS_CURRENT_PATH,
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  MODEL_GEOMETRY_REALIZATION_CURRENT_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_READINESS_PATH,
  MODEL_REGIONS_PATH,
  MODEL_SCENE_PATH,
  MODEL_STUDY_PATH,
  SIMULATION_PREPARATION_PATH,
  SIMULATION_RUN_CURRENT_PATH,
  SIMULATION_SOLVER_ENERGIES_CURRENT_PATH,
  SIMULATION_SOLVER_ENERGIES_HISTORY_PATH,
  SIMULATION_SOLVER_STATUS_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
  SIMULATION_STAGES_RESULTS_PATH,
  VISUALIZATION_STATE_PATH,
} from "@/kernel/api/apiPaths";
import type { ResourceRevision } from "@/kernel/api/apiTypes";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";

export const AUTHORING_MUTATION_DEPENDENTS = {
  geometry: [
    MODEL_SCENE_PATH,
    MODEL_GEOMETRY_REALIZATION_CURRENT_PATH,
    MODEL_GEOMETRY_VALIDATION_PATH,
    MODEL_GEOMETRY_DIAGNOSTICS_PATH,
    MODEL_READINESS_PATH,
    SESSION_STATUS_RESOURCE_KEY,
    SIMULATION_PREPARATION_PATH,
    SIMULATION_STAGES_EXECUTION_PATH,
    SIMULATION_STAGES_RESULTS_PATH,
    DATA_OBSERVATION_FRAMES_PATH,
    MESHING_BUILDS_CURRENT_PATH,
    MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
    DATA_FIELDS_PATH,
  ],
  magnetization: [
    MODEL_SCENE_PATH,
    MODEL_REGIONS_PATH,
    MODEL_GEOMETRY_VALIDATION_PATH,
    MODEL_GEOMETRY_DIAGNOSTICS_PATH,
    MODEL_READINESS_PATH,
    SESSION_STATUS_RESOURCE_KEY,
    SIMULATION_PREPARATION_PATH,
    SIMULATION_STAGES_EXECUTION_PATH,
    SIMULATION_STAGES_RESULTS_PATH,
    DATA_OBSERVATION_FRAMES_PATH,
    DATA_FIELDS_PATH,
    DATA_SCALARS_PATH,
    SIMULATION_RUN_CURRENT_PATH,
    SIMULATION_SOLVER_STATUS_PATH,
    SIMULATION_SOLVER_ENERGIES_CURRENT_PATH,
    SIMULATION_SOLVER_ENERGIES_HISTORY_PATH,
  ],
  material: [
    MODEL_SCENE_PATH,
    MODEL_GEOMETRY_VALIDATION_PATH,
    MODEL_GEOMETRY_DIAGNOSTICS_PATH,
    MODEL_READINESS_PATH,
    SESSION_STATUS_RESOURCE_KEY,
    SIMULATION_PREPARATION_PATH,
    SIMULATION_STAGES_EXECUTION_PATH,
    SIMULATION_STAGES_RESULTS_PATH,
    DATA_OBSERVATION_FRAMES_PATH,
    VISUALIZATION_STATE_PATH,
    DATA_FIELDS_PATH,
    DATA_SCALARS_PATH,
    SIMULATION_RUN_CURRENT_PATH,
    SIMULATION_SOLVER_STATUS_PATH,
    SIMULATION_SOLVER_ENERGIES_CURRENT_PATH,
    SIMULATION_SOLVER_ENERGIES_HISTORY_PATH,
  ],
  interaction: [
    MODEL_SCENE_PATH,
    MODEL_STUDY_PATH,
    MODEL_READINESS_PATH,
    SESSION_STATUS_RESOURCE_KEY,
    SIMULATION_PREPARATION_PATH,
    SIMULATION_STAGES_EXECUTION_PATH,
    SIMULATION_STAGES_RESULTS_PATH,
    DATA_OBSERVATION_FRAMES_PATH,
    VISUALIZATION_STATE_PATH,
    DATA_FIELDS_PATH,
    DATA_SCALARS_PATH,
    SIMULATION_RUN_CURRENT_PATH,
    SIMULATION_SOLVER_STATUS_PATH,
    SIMULATION_SOLVER_ENERGIES_CURRENT_PATH,
    SIMULATION_SOLVER_ENERGIES_HISTORY_PATH,
  ],
} as const;

type AuthoringMutationKind = keyof typeof AUTHORING_MUTATION_DEPENDENTS;

export function acknowledgedAuthoringSceneRevision(response: {
  revision?: unknown;
  scene_revision?: unknown;
}): number {
  const revision = response.scene_revision ?? response.revision;
  if (typeof revision !== "number" || !Number.isFinite(revision)) {
    throw new Error("Authoring mutation ACK omitted the scene revision.");
  }
  return revision;
}

export function invalidateAuthoringMutationDependents(
  resources: {
    invalidate(resourceKey: string, revision: ResourceRevision): void;
    invalidatePrefix?(resourcePrefix: string, revision: ResourceRevision): unknown;
  },
  kind: AuthoringMutationKind,
  revision: ResourceRevision,
): void {
  // Scene revisions and observation revisions belong to independent clocks.
  const sceneRevision = `scene:${revision}`;
  for (const resourceKey of AUTHORING_MUTATION_DEPENDENTS[kind]) {
    const sceneDependent = resourceKey === SIMULATION_PREPARATION_PATH ||
      resourceKey === SIMULATION_STAGES_EXECUTION_PATH ||
      resourceKey === SIMULATION_STAGES_RESULTS_PATH ||
      resourceKey === DATA_FIELDS_PATH ||
      resourceKey === DATA_OBSERVATION_FRAMES_PATH;
    resources.invalidate(resourceKey, sceneDependent ? sceneRevision : revision);
  }

  // The manifest also reports which scene was validated against the retained mesh.
  resources.invalidate(MESHING_SHARED_DOMAIN_MANIFEST_PATH, sceneRevision);

  // Live fields carry quantity, scope and sampling query segments. Historical
  // results have their own paths and keep their pinned field and geometry data.
  resources.invalidatePrefix?.(`${DATA_FIELDS_PATH}/`, sceneRevision);
  resources.invalidatePrefix?.(`${DATA_FIELDS_PATH}?`, sceneRevision);
  resources.invalidatePrefix?.(`${DATA_FIELDS_PATH}#viewport-3d:`, sceneRevision);
  resources.invalidatePrefix?.(`${DATA_OBSERVATION_FRAMES_PATH}?`, sceneRevision);
  resources.invalidatePrefix?.(`${SIMULATION_STAGES_RESULTS_PATH}?`, sceneRevision);
  // History keys carry a window such as `?limit=` that exact invalidation never reaches.
  resources.invalidatePrefix?.(SIMULATION_SOLVER_ENERGIES_HISTORY_PATH, revision);
}
