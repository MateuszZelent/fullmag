import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  resolveAvailableObjectExtensions as resolveRegisteredObjectExtensions,
} from "./objectExtensionRegistry";
import type {
  ObjectExtensionActivationState,
  ObjectExtensionId,
  ObjectExtensionRowModel,
  ObjectExtensionsSectionModel,
} from "./objectExtensionTypes";

export function objectExtensionActivationKey(
  objectId: string,
  extensionId: ObjectExtensionId,
): string {
  return `${objectId}:${extensionId}`;
}

export function createObjectExtensionActivationState(): ObjectExtensionActivationState {
  return { enabled: {} };
}

export function setObjectExtensionEnabled(
  state: ObjectExtensionActivationState,
  objectId: string,
  extensionId: ObjectExtensionId,
  enabled: boolean,
): ObjectExtensionActivationState {
  return {
    enabled: {
      ...state.enabled,
      [objectExtensionActivationKey(objectId, extensionId)]: enabled,
    },
  };
}

export function resolveAvailableObjectExtensions(selection: Selection) {
  return resolveRegisteredObjectExtensions(selection);
}

export function resolveObjectExtensionsSectionModel(
  selection: Selection,
  activation: ObjectExtensionActivationState,
): ObjectExtensionsSectionModel {
  const objectId = selection.ref?.type === "scene-object"
    ? selection.ref.objectId
    : selection.objectId;
  const extensions = objectId
    ? resolveAvailableObjectExtensions(selection).map<ObjectExtensionRowModel>(
        (extension) => {
          const enabled = Boolean(
            activation.enabled[objectExtensionActivationKey(objectId, extension.id)] ??
              extension.defaultEnabled,
          );
          return {
            enabled,
            id: extension.id,
            label: extension.label,
            status: enabled ? "enabled" : "disabled",
            summary: enabled ? "enabled" : "disabled",
          };
        },
      )
    : [];
  const activeCount = extensions.filter((extension) => extension.enabled).length;

  return {
    activeCount,
    badge: activeCount > 0 ? `Active: ${activeCount}` : undefined,
    extensions,
    visible: extensions.length > 0,
  };
}

export function resolveActiveObjectExtensionExplorerItems(
  objectId: string,
  activation: ObjectExtensionActivationState,
): Array<{ id: ObjectExtensionId; label: string; status: "ready" }> {
  return resolveRegisteredObjectExtensions({
    kind: "object.root",
    label: objectId,
    moduleSource: "inspector",
    nodeId: `model:object:${objectId}`,
    objectId,
    ref: {
      kind: "object.root",
      nodeId: `model:object:${objectId}`,
      objectId,
      type: "scene-object",
      visualizationTargetId: `object:${objectId}`,
    },
  })
    .filter((extension) =>
      Boolean(activation.enabled[objectExtensionActivationKey(objectId, extension.id)]),
    )
    .map((extension) => ({
      id: extension.id,
      label: extension.label,
      status: "ready",
    }));
}
