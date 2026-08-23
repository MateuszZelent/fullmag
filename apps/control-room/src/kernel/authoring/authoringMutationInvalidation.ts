import {
  MESHING_BUILDS_CURRENT_PATH,
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_READINESS_PATH,
  MODEL_REGIONS_PATH,
  MODEL_SCENE_PATH,
  VISUALIZATION_STATE_PATH,
} from "@/kernel/api/apiPaths";
import type { ResourceRevision } from "@/kernel/api/apiTypes";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";

export const AUTHORING_MUTATION_DEPENDENTS = {
  geometry: [
    MODEL_SCENE_PATH,
    MODEL_GEOMETRY_VALIDATION_PATH,
    MODEL_GEOMETRY_DIAGNOSTICS_PATH,
    MODEL_READINESS_PATH,
    SESSION_STATUS_RESOURCE_KEY,
    MESHING_BUILDS_CURRENT_PATH,
    MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  ],
  magnetization: [
    MODEL_SCENE_PATH,
    MODEL_REGIONS_PATH,
    MODEL_GEOMETRY_VALIDATION_PATH,
    MODEL_GEOMETRY_DIAGNOSTICS_PATH,
    MODEL_READINESS_PATH,
    SESSION_STATUS_RESOURCE_KEY,
    VISUALIZATION_STATE_PATH,
  ],
  material: [
    MODEL_SCENE_PATH,
    MODEL_GEOMETRY_VALIDATION_PATH,
    MODEL_GEOMETRY_DIAGNOSTICS_PATH,
    MODEL_READINESS_PATH,
    SESSION_STATUS_RESOURCE_KEY,
    MESHING_BUILDS_CURRENT_PATH,
    MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
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
  },
  kind: AuthoringMutationKind,
  revision: ResourceRevision,
): void {
  for (const resourceKey of AUTHORING_MUTATION_DEPENDENTS[kind]) {
    resources.invalidate(resourceKey, revision);
  }
}
