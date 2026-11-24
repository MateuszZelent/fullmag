import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { SceneResource } from "@/kernel/api/apiTypes";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "@/kernel/authoring/authoringMutationInvalidation";
import { publishCommittedSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import type { KernelApi } from "@/kernel/types";

export interface GeometryHistoryTransactionResponse {
  committed_scene?: SceneResource;
  scene_revision?: number;
}

export interface CommitGeometryStackTransactionParams<
  TResponse extends GeometryHistoryTransactionResponse,
> {
  kernel: KernelApi;
  label: string;
  sceneData: SceneResource | null | undefined;
  sessionScopeKey: string | null;
  execute: (params: { baseRevision: number | null }) => Promise<TResponse>;
}

/**
 * Unified Undo/Redo-backed runner for structural geometry stack mutations
 * (Boolean operations, cutouts, reordering, extraction, operand removal,
 * and GeometryNode commits).
 */
export async function commitGeometryStackTransaction<
  TResponse extends GeometryHistoryTransactionResponse,
>({
  kernel,
  label,
  sceneData,
  sessionScopeKey,
  execute,
}: CommitGeometryStackTransactionParams<TResponse>): Promise<TResponse> {
  const capturedScopeKey = sessionScopeKey;
  const capturedCommandScopeKey = kernel.commands?.getSessionScopeKey?.();
  const historyGeneration = kernel.authoringHistory?.getGeneration?.();

  const isCurrentSessionScope = () => {
    const activeCommandScope = kernel.commands?.getSessionScopeKey?.();
    if (
      capturedCommandScopeKey !== undefined &&
      activeCommandScope !== undefined &&
      activeCommandScope !== capturedCommandScopeKey
    ) {
      return false;
    }
    return (
      historyGeneration === undefined ||
      kernel.authoringHistory?.getGeneration?.() === historyGeneration
    );
  };

  const sceneRevision =
    typeof sceneData?.revision === "number" && Number.isFinite(sceneData.revision)
      ? sceneData.revision
      : null;

  const historyContext = {
    api: kernel.api,
    authoringHistory: kernel.authoringHistory,
    layout: kernel.layout,
    resourceData: { [MODEL_SCENE_PATH]: sceneData },
    selection: kernel.selection,
    sessionScopeKey: capturedScopeKey,
    isCurrentSessionScope,
  };

  const response = await runAuthoringMutationWithHistory(
    historyContext,
    label,
    ({ baseRevision }) => execute({ baseRevision: baseRevision ?? sceneRevision }),
    undefined,
    sceneRevision !== null ? { expectedSceneRevision: sceneRevision } : undefined,
  );

  if (!isCurrentSessionScope()) {
    return response;
  }

  const rev = acknowledgedAuthoringSceneRevision(response);
  if (response.committed_scene) {
    publishCommittedSceneResource(
      kernel.resources,
      response.committed_scene,
      rev,
      undefined,
      false,
      capturedScopeKey,
      kernel.api.resourceCacheScope,
    );
  }
  invalidateAuthoringMutationDependents(kernel.resources, "geometry", rev);

  return response;
}
