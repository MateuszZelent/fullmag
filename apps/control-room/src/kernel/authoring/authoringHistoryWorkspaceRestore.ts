import type { SceneResource } from "../api/apiTypes";
import { selectionRefEquals, type Selection } from "../selection/selectionTypes";
import type { SelectionController } from "../selection/SelectionController";
import type { AuthoringHistoryWorkspaceTransition } from "./AuthoringHistoryController";

export interface AuthoringHistoryWorkspaceControllers {
  selection?: Pick<SelectionController, "clear" | "get" | "set"> | null;
}

function selectionEquals(left: Selection | null, right: Selection | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.kind === right.kind &&
    left.label === right.label &&
    left.nodeId === right.nodeId &&
    left.objectId === right.objectId &&
    selectionRefEquals(left.ref, right.ref);
}

function isEmptySelection(selection: Selection | null): boolean {
  return !selection || (
    selection.kind === null &&
    selection.label === null &&
    selection.nodeId === null &&
    selection.objectId === null &&
    selection.ref === null
  );
}

function sceneObjectId(selection: Selection | null): string | null {
  return selection?.objectId && (
    selection.kind === "object" || selection.kind?.startsWith("object.")
  )
    ? selection.objectId
    : null;
}

function sceneContainsObject(scene: SceneResource, objectId: string): boolean {
  const objects = (scene as unknown as { objects?: unknown }).objects;
  if (Array.isArray(objects)) {
    return objects.some((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return false;
      }
      const object = candidate as Record<string, unknown>;
      return object.object_id === objectId || object.id === objectId;
    });
  }
  if (objects && typeof objects === "object") {
    return Object.hasOwn(objects, objectId);
  }
  return false;
}

function canRestoreSelection(
  selection: Selection,
  scene: SceneResource,
): boolean {
  const objectId = sceneObjectId(selection);
  return objectId === null || sceneContainsObject(scene, objectId);
}

function applySelection(
  controller: NonNullable<AuthoringHistoryWorkspaceControllers["selection"]>,
  selection: Selection,
): void {
  if (isEmptySelection(selection)) {
    controller.clear("authoring-history");
    return;
  }
  controller.set({
    kind: selection.kind,
    label: selection.label,
    nodeId: selection.nodeId,
    objectId: selection.objectId,
    ref: selection.ref,
  }, "authoring-history");
}

/**
 * Restore an authoring selection only while the workspace still reflects the
 * corresponding side of that transition. A newer valid selection belongs to
 * the user and remains untouched. Layout focus is not part of semantic history.
 */
export function applyAuthoringHistoryWorkspaceTransition(
  controllers: AuthoringHistoryWorkspaceControllers,
  transition: AuthoringHistoryWorkspaceTransition,
): void {
  const selectionController = controllers.selection;
  if (selectionController) {
    const current = selectionController.get();
    const expectedSelection = transition.expected.selection;
    const restoreSelection = transition.restore.selection;
    const matchesExpected = selectionEquals(current, expectedSelection);
    const currentObjectId = sceneObjectId(current);
    const currentObjectExists = currentObjectId === null ||
      sceneContainsObject(transition.scene, currentObjectId);

    if (matchesExpected && restoreSelection && canRestoreSelection(restoreSelection, transition.scene)) {
      applySelection(selectionController, restoreSelection);
    } else if (!currentObjectExists) {
      if (restoreSelection && canRestoreSelection(restoreSelection, transition.scene)) {
        applySelection(selectionController, restoreSelection);
      } else {
        selectionController.clear("authoring-history");
      }
    }
  }
}
