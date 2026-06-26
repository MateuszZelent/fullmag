import type { Selection } from "@/kernel/selection/selectionTypes";

import type { ObjectExtensionDefinition } from "./objectExtensionTypes";

function isCommittedObjectRoot(selection: Selection): boolean {
  return (
    selection.kind === "object.root" &&
    selection.ref?.type === "scene-object" &&
    Boolean(selection.ref.objectId)
  );
}

export const OBJECT_EXTENSION_REGISTRY: readonly ObjectExtensionDefinition[] = [
  {
    defaultEnabled: false,
    description: "Computes skyrmion topological charge from object field data.",
    id: "topological_charge",
    isAvailable: isCommittedObjectRoot,
    label: "Topological Charge",
  },
];

export function resolveAvailableObjectExtensions(
  selection: Selection,
): readonly ObjectExtensionDefinition[] {
  return OBJECT_EXTENSION_REGISTRY.filter((extension) =>
    extension.isAvailable(selection),
  );
}
