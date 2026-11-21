import type { ObjectInteractionKind } from "@/kernel/api/apiTypes";
import { acknowledgedAuthoringSceneRevision, invalidateAuthoringMutationDependents } from "@/kernel/authoring/authoringMutationInvalidation";
import { resolveObjectInteractionResourceKey } from "@/kernel/resources/geometryLifecycleResources";

export async function commitObjectInteractionMutation({
  interactionKind,
  objectId,
  patch,
  resources,
}: {
  interactionKind: ObjectInteractionKind;
  objectId: string;
  patch: () => Promise<{ revision?: unknown; scene_revision?: unknown }>;
  resources: { invalidate(resourceKey: string, revision: number): void };
}): Promise<number> {
  const response = await patch();
  const revision = acknowledgedAuthoringSceneRevision(response);
  resources.invalidate(
    resolveObjectInteractionResourceKey(objectId, interactionKind),
    revision,
  );
  invalidateAuthoringMutationDependents(resources, "interaction", revision);
  return revision;
}
