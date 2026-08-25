import { ControlRoomApiError, type ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import type { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import type { SceneResource } from "@/kernel/api/apiTypes";

import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "./authoringMutationInvalidation";
import { commitObjectTransformTransaction } from "./geometryLifecycleCommands";
import { publishCommittedSceneResource } from "@/kernel/resources/geometryLifecycleResources";

export type ObjectTranslation = [number, number, number];
export const PROBLEM_IR_03_RIGID_TRANSFORM_REASON =
  "Rotate and Scale require a canonical geometry contract newer than ProblemIR 0.3.";

export function isObjectTranslationRevisionConflict(error: unknown): boolean {
  return error instanceof ControlRoomApiError &&
    error.status === 409 &&
    (error.code === "revision_conflict" || error.code === "scene_revision_conflict");
}

/** One revision-safe translation transaction shared by Inspector and viewport. */
export async function commitObjectTranslation({
  api,
  baseRevision,
  objectId,
  resources,
  translation,
}: {
  api: ControlRoomApi;
  baseRevision: number;
  objectId: string;
  resources: ResourceInvalidationController;
  translation: ObjectTranslation;
}): Promise<{ committedScene?: SceneResource; revision: number }> {
  const response = await commitObjectTransformTransaction(api, objectId, {
    base_revision: baseRevision,
    transform: { translation },
  });
  const revision = acknowledgedAuthoringSceneRevision(response);
  if (response.committed_scene) {
    publishCommittedSceneResource(
      resources,
      response.committed_scene,
      revision,
      undefined,
      false,
    );
  }
  invalidateAuthoringMutationDependents(resources, "geometry", revision);
  return { committedScene: response.committed_scene, revision };
}
