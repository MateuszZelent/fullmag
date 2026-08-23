import type { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import type { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";

import {
  commitObjectTranslation,
  isObjectTranslationRevisionConflict,
  type ObjectTranslation,
} from "./objectTranslationMutation";

export interface ObjectMoveConflict {
  baseRevision: number;
  objectId: string;
  phase: "conflict" | "rebased" | "retrying";
  translation: ObjectTranslation;
}

export async function commitObjectMoveWorkflow(options: {
  api: ControlRoomApi;
  baseRevision: number;
  objectId: string;
  onAcknowledged: () => void;
  onConflict: (conflict: ObjectMoveConflict) => void;
  resources: ResourceInvalidationController;
  translation: ObjectTranslation;
}): Promise<boolean> {
  try {
    await commitObjectTranslation(options);
    options.onAcknowledged();
    return true;
  } catch (error) {
    if (!isObjectTranslationRevisionConflict(error)) throw error;
    options.onConflict({
      baseRevision: options.baseRevision,
      objectId: options.objectId,
      phase: "conflict",
      translation: [...options.translation],
    });
    return false;
  }
}

export function rebaseObjectMoveConflict(
  conflict: ObjectMoveConflict,
  sceneRevision: number,
): ObjectMoveConflict {
  return { ...conflict, baseRevision: sceneRevision, phase: "rebased" };
}
