import type { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import type { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import type { RequestOptions, SceneResource } from "@/kernel/api/apiTypes";

import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "./authoringMutationInvalidation";
import { commitObjectTransformTransaction } from "./geometryLifecycleCommands";
import { publishCommittedSceneResource } from "@/kernel/resources/geometryLifecycleResources";

export type ObjectTranslation = [number, number, number];
export const PROBLEM_IR_03_RIGID_TRANSFORM_REASON =
  "Rotate and Scale require a canonical geometry contract newer than ProblemIR 0.3.";

/** One revision-safe translation transaction shared by Inspector and viewport. */
export async function commitObjectTranslation({
  api,
  baseRevision,
  objectId,
  resources,
  sessionScopeKey,
  isCurrentSessionScope,
  translation,
}: {
  api: ControlRoomApi;
  baseRevision: number;
  objectId: string;
  resources: ResourceInvalidationController;
  sessionScopeKey?: string;
  isCurrentSessionScope?: () => boolean;
  translation: ObjectTranslation;
}): Promise<{ committedScene?: SceneResource; revision: number }> {
  const requestOptions: RequestOptions | undefined = sessionScopeKey
    ? { sessionScopeKey }
    : undefined;
  const response = await commitObjectTransformTransaction(
    api,
    objectId,
    {
      base_revision: baseRevision,
      transform: { translation },
    },
    requestOptions,
  );
  const revision = acknowledgedAuthoringSceneRevision(response);
  if (isCurrentSessionScope?.() === false) {
    return { committedScene: response.committed_scene, revision };
  }
  if (response.committed_scene) {
    publishCommittedSceneResource(
      resources,
      response.committed_scene,
      revision,
      undefined,
      false,
      sessionScopeKey,
      api.resourceCacheScope,
    );
  }
  invalidateAuthoringMutationDependents(resources, "geometry", revision);
  return { committedScene: response.committed_scene, revision };
}
