import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { SceneResource } from "@/kernel/api/apiTypes";
import {
  authoringWriteOptions,
  captureAuthoringMutationFence,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "@/kernel/authoring/authoringMutationInvalidation";
import type { CommandContext, CommandContribution, CommandResult } from "@/kernel/commands/commandTypes";
import { obsoleteSessionResult } from "@/kernel/commands/commandSessionScope";
import { publishCommittedSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { visualizationTargetIdForSceneObject } from "@/kernel/selection/selectionTypes";
import { initialAbsorbingBoundary } from "@/shared/domain/physics/absorbingBoundary";

function pendingEditReason(context: CommandContext): string | null {
  const scope = context.sessionScopeKey ?? null;
  const edits = context.objectEditSession;
  const draft = edits?.getSnapshot();
  if (draft?.dirty && draft.identity?.sessionScopeKey === scope) {
    return "Apply or revert the object's geometry changes first.";
  }
  if (edits?.hasActiveGesture(scope)) return "Finish the active geometry edit first.";
  return context.pendingForms?.getTransitionSnapshot().blockedReason ?? null;
}

function boundaryTarget(context: CommandContext) {
  const { api, resources, selection, sessionScopeKey: scope } = context;
  if (!api || !resources || !scope || !context.isCurrentSessionScope?.()) {
    return { reason: "Wait for the current session before opening an absorbing boundary." } as const;
  }
  const selected = selection?.get();
  const ref = selected?.ref;
  if (!selection || selected?.kind !== "object.root" || ref?.type !== "scene-object" ||
    ref.kind !== "object.root" || ref.objectId !== selected.objectId) {
    return { reason: "Select a magnetic object in the viewport or Explorer." } as const;
  }
  const scene = context.resourceData?.[MODEL_SCENE_PATH] as SceneResource | null | undefined;
  const revision = scene?.scene_revision ?? scene?.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    return { reason: "Wait for the revisioned model scene." } as const;
  }
  const object = scene?.objects?.find(candidate => candidate.id === ref.objectId);
  if (object?.role !== "magnet") return { reason: "Select a magnetic object in the current scene." } as const;
  if (object.locked && !object.absorbing_boundary) return { reason: "Unlock the object before adding an absorbing boundary." } as const;
  if (context.objectEditSession?.hasPendingWrite(scope)) {
    return { reason: "Wait for the pending scene change." } as const;
  }
  const reason = pendingEditReason(context);
  if (reason) return { reason } as const;
  return { reason: null, api, resources, selection, scope, object, revision } as const;
}

async function addAbsorbingBoundary(context: CommandContext): Promise<CommandResult> {
  const target = boundaryTarget(context);
  if (target.reason !== null) return { status: "failed", message: target.reason };
  const { api, resources, selection, scope } = target;
  const { objectEditSession } = context;
  const objectId = target.object.id;
  const sourceSelection = selection.get();
  const fence = captureAuthoringMutationFence(context);
  if (!target.object.absorbing_boundary) {
    const reservation = objectEditSession?.beginSceneMutation(scope, objectId);
    if (reservation === null) return { status: "failed", message: "Wait for the pending scene change." };
    try {
      const committed = await runAuthoringMutationWithHistory(
        fence, `Add absorbing boundary to ${objectId}`,
        async () => {
          if (selection.get() !== sourceSelection) throw new Error("The selection changed before adding the absorbing boundary.");
          const blocked = pendingEditReason(context);
          if (blocked) throw new Error(blocked);
          return api.model.patchObject(objectId, {
            base_revision: target.revision,
            absorbing_boundary: initialAbsorbingBoundary(),
          }, authoringWriteOptions(target.revision, scope));
        },
        undefined, { expectedSceneRevision: target.revision },
      );
      const obsolete = obsoleteSessionResult(fence);
      if (obsolete) return obsolete;
      const revision = acknowledgedAuthoringSceneRevision(committed);
      publishCommittedSceneResource(resources, committed, revision, undefined, false, scope, api.resourceCacheScope);
      invalidateAuthoringMutationDependents(resources, "material", revision);
      if (!committed.objects?.some(object => object.id === objectId && object.absorbing_boundary)) {
        return { status: "failed", message: "The scene did not confirm the selected object's absorbing boundary." };
      }
    } finally {
      if (reservation !== undefined) objectEditSession?.endSceneMutation(reservation);
    }
  }
  const obsolete = obsoleteSessionResult(fence);
  if (obsolete) return obsolete;
  if (selection.get() !== sourceSelection || pendingEditReason(context)) {
    return { status: "completed", message: "Absorbing boundary saved." };
  }
  const nodeId = `model:object:${objectId}:magnetic-parameters:absorbing-boundary`;
  selection.set({
    kind: "object.absorbing-boundary", label: "Absorbing Boundary", nodeId, objectId,
    ref: { type: "scene-object", kind: "object.absorbing-boundary", nodeId, objectId,
      visualizationTargetId: visualizationTargetIdForSceneObject(objectId) },
  }, context.source);
  if (selection.get().nodeId === nodeId) context.layout?.setPanelVisible("right", true);
  return { status: "completed" };
}

export const addAbsorbingBoundaryCommand: CommandContribution = {
  id: "physics.add-absorbing-boundary",
  title: "Add Absorbing Boundary",
  group: "ribbon-physics", category: "Physics", scope: "selection",
  isEnabled: context => !boundaryTarget(context).reason,
  disabledReason: context => boundaryTarget(context).reason,
  run: addAbsorbingBoundary,
};
